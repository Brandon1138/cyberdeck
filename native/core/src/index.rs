use crate::{
    Result,
    instruction::{Instruction, Status, js_trim},
};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeSet, HashMap},
    fs::{self, File, Metadata},
    io::{self, BufRead, BufReader, Read, Seek, SeekFrom},
    os::unix::fs::MetadataExt,
    path::Path,
};

const MAX_LINE: u64 = 8 * 1024 * 1024;
#[derive(PartialEq)]
struct Version(u64, u64, u64, i64, i64, i64, i64);
impl From<Metadata> for Version {
    fn from(m: Metadata) -> Self {
        Self(
            m.dev(),
            m.ino(),
            m.len(),
            m.mtime(),
            m.mtime_nsec(),
            m.ctime(),
            m.ctime_nsec(),
        )
    }
}

#[derive(Default)]
pub struct Index {
    records: Vec<Instruction>,
    unsettled: BTreeSet<usize>,
    ids: HashMap<String, usize>,
    targets: HashMap<String, BTreeSet<usize>>,
    committed: u64,
    prefix: Sha256,
    version: Option<Version>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Query {
    All,
    Unsettled,
    Id(String),
    Target(String),
}

impl Index {
    fn remove_target(&mut self, target: &str, position: usize) {
        if let Some(set) = self.targets.get_mut(target) {
            set.remove(&position);
            if set.is_empty() {
                self.targets.remove(target);
            }
        }
    }
    fn apply(&mut self, mut row: Instruction) -> Result<()> {
        row.validate()?;
        let position = self.ids.get(&row.id).copied().unwrap_or(self.records.len());
        if matches!(
            row.status,
            Status::Completed | Status::Cancelled | Status::Undelivered
        ) {
            self.unsettled.remove(&position);
        } else {
            self.unsettled.insert(position);
        }
        if let Some(&i) = self.ids.get(&row.id) {
            let old = &self.records[i];
            row.follows(old)?;
            if old.effective_target() != row.effective_target() {
                let former = old.effective_target().to_owned();
                if former != old.target_session_id {
                    self.remove_target(&former, i);
                }
                self.targets
                    .entry(row.effective_target().to_owned())
                    .or_default()
                    .insert(i);
            }
            self.records[i] = row;
        } else {
            let i = self.records.len();
            self.ids.insert(row.id.clone(), i);
            self.targets
                .entry(row.target_session_id.clone())
                .or_default()
                .insert(i);
            if row.effective_target() != row.target_session_id {
                self.targets
                    .entry(row.effective_target().to_owned())
                    .or_default()
                    .insert(i);
            }
            self.records.push(row);
        }
        Ok(())
    }

    // An external append can also rewrite the prefix in place. Hash the complete
    // committed prefix before reusing its validation, including blank lines.
    fn replay(&mut self, file: &mut File) -> Result<()> {
        if self.committed > 0 {
            let mut hash = Sha256::new();
            let bytes = io::copy(&mut file.take(self.committed), &mut hash)?;
            if bytes != self.committed || hash.finalize() != self.prefix.clone().finalize() {
                *self = Self::default();
                file.seek(SeekFrom::Start(0))?;
            }
        }
        let mut reader = BufReader::new(file);
        let mut line = Vec::new();
        loop {
            line.clear();
            reader
                .by_ref()
                .take(MAX_LINE + 1)
                .read_until(b'\n', &mut line)?;
            if line.len() as u64 > MAX_LINE {
                return Err("Instruction exceeds native line limit".into());
            }
            if !line.ends_with(b"\n") {
                break;
            }
            let text = std::str::from_utf8(&line)?;
            if !js_trim(text).is_empty() {
                self.apply(serde_json::from_str(text)?)?;
            }
            self.committed += line.len() as u64;
            self.prefix.update(&line);
        }
        Ok(())
    }

    pub fn refresh(&mut self, path: &Path) -> Result<()> {
        for _ in 0..3 {
            let mut file = match File::open(path) {
                Ok(file) => file,
                Err(err) if err.kind() == io::ErrorKind::NotFound => {
                    *self = Self::default();
                    return Ok(());
                }
                Err(err) => return Err(err.into()),
            };
            let before = Version::from(file.metadata()?);
            if self.version.as_ref() != Some(&before) {
                self.replay(&mut file)?;
            }
            let after = Version::from(file.metadata()?);
            let current = match fs::metadata(path) {
                Ok(m) => Some(Version::from(m)),
                Err(err) if err.kind() == io::ErrorKind::NotFound => None,
                Err(err) => return Err(err.into()),
            };
            if before == after && current.as_ref() == Some(&after) {
                self.version = Some(after);
                return Ok(());
            }
            *self = Self::default();
        }
        Err("Journal changed during validation".into())
    }
    pub fn query(
        &self,
        query: Query,
        mut emit: impl FnMut(&Instruction) -> Result<()>,
    ) -> Result<()> {
        match query {
            Query::Unsettled => {
                for &i in &self.unsettled {
                    emit(&self.records[i])?;
                }
            }
            Query::All => {
                for r in &self.records {
                    emit(r)?;
                }
            }
            Query::Id(id) => {
                if let Some(i) = self.ids.get(&id) {
                    emit(&self.records[*i])?;
                }
            }
            Query::Target(id) => {
                if let Some(indices) = self.targets.get(&id) {
                    for &i in indices {
                        emit(&self.records[i])?;
                    }
                }
            }
        }
        Ok(())
    }
}
