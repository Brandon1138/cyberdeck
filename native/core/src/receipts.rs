use crate::Result;
use crate::instruction::js_trim;
use crate::validation::{SafeInt, optional, timestamp, uuid};
use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Recipient {
    pub kind: String,
    pub key: String,
}

#[derive(Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Continuation {
    pub instruction_id: String,
    pub original_actor_session_id: String,
    pub original_target_session_id: String,
    pub transition_id: String,
    pub incarnation: SafeInt,
    pub generation: SafeInt,
    pub effective_actor_session_id: String,
    pub effective_target_session_id: String,
    #[serde(
        default,
        deserialize_with = "optional",
        skip_serializing_if = "Option::is_none"
    )]
    pub effective_sender_session_id: Option<String>,
    pub at: String,
}
impl Continuation {
    pub fn validate(&self) -> Result<()> {
        for id in [
            &self.effective_actor_session_id,
            &self.effective_target_session_id,
        ]
        .into_iter()
        .chain(self.effective_sender_session_id.iter())
        {
            uuid(id)?;
        }
        if self.transition_id.is_empty() || self.incarnation.0 == 0 || self.generation.0 == 0 {
            return Err("Invalid continuation".into());
        }
        timestamp(&self.at)
    }
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Attempt {
    pub target_session_id: String,
    pub actor_session_id: String,
    pub generation: SafeInt,
    pub at: String,
    pub outcome: String,
}
impl Attempt {
    pub fn validate(&self) -> Result<()> {
        uuid(&self.target_session_id)?;
        uuid(&self.actor_session_id)?;
        timestamp(&self.at)?;
        if self.generation.0 == 0 || !matches!(self.outcome.as_str(), "unknown" | "refused") {
            return Err("Invalid submission attempt".into());
        }
        Ok(())
    }
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Authority {
    path: String,
    sha256: String,
}
#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Withdrawal {
    kind: String,
    reason: String,
    authority: Authority,
    at: String,
}
impl Withdrawal {
    pub fn validate(&mut self) -> Result<()> {
        self.reason = js_trim(&self.reason).to_owned();
        if self.kind != "operator"
            || self.reason.is_empty()
            || !self.authority.path.starts_with('/')
            || self.authority.sha256.len() != 64
            || !self
                .authority
                .sha256
                .bytes()
                .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
        {
            return Err("Invalid withdrawal".into());
        }
        timestamp(&self.at)
    }
}
