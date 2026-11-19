use crate::Result;
use crate::receipts::{Attempt, Continuation, Recipient, Withdrawal};
use crate::validation::{SafeInt, optional, timestamp, uuid};
use serde::{Deserialize, Serialize};

// Preserve ECMAScript String.trim semantics at the existing wire boundary.
// Rust str::trim additionally strips NEL and does not strip BOM.
fn js_space(c: char) -> bool {
    matches!(c,'\u{0009}'..='\u{000d}'|'\u{0020}'|'\u{00a0}'|'\u{1680}'|'\u{2000}'..='\u{200a}'|'\u{2028}'|'\u{2029}'|'\u{202f}'|'\u{205f}'|'\u{3000}'|'\u{feff}')
}
pub fn js_trim(s: &str) -> &str {
    s.trim_matches(js_space)
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Status {
    Accepted,
    Queued,
    #[serde(alias = "delivered")]
    Rendered,
    Submitted,
    Acknowledged,
    Completed,
    Undelivered,
    Cancelled,
}
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Wake {
    pub controller_id: String,
    pub cursor: SafeInt,
    pub notification_ids: Vec<String>,
    #[serde(
        default,
        deserialize_with = "optional",
        skip_serializing_if = "Option::is_none"
    )]
    pub attention_epoch: Option<String>,
}
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Instruction {
    #[serde(
        default,
        deserialize_with = "optional",
        skip_serializing_if = "Option::is_none"
    )]
    pub logical_recipient: Option<Recipient>,
    #[serde(
        default,
        deserialize_with = "optional",
        skip_serializing_if = "Option::is_none"
    )]
    pub continuations: Option<Vec<Continuation>>,
    #[serde(
        default,
        deserialize_with = "optional",
        skip_serializing_if = "Option::is_none"
    )]
    pub submission_attempt: Option<Attempt>,
    #[serde(
        default,
        deserialize_with = "optional",
        skip_serializing_if = "Option::is_none"
    )]
    pub hold_detail: Option<String>,
    #[serde(
        default,
        deserialize_with = "optional",
        skip_serializing_if = "Option::is_none"
    )]
    pub delivery_attempt_at: Option<String>,
    #[serde(
        default,
        deserialize_with = "optional",
        skip_serializing_if = "Option::is_none"
    )]
    pub withdrawal: Option<Withdrawal>,

    pub id: String,
    pub actor_session_id: String,
    pub target_session_id: String,
    pub message: String,
    pub status: Status,
    pub created_at: String,
    pub updated_at: String,
    pub message_id: String,
    #[serde(default)]
    pub hop: SafeInt,
    #[serde(
        default,
        deserialize_with = "optional",
        skip_serializing_if = "Option::is_none"
    )]
    pub sender_session_id: Option<String>,
    #[serde(
        default,
        deserialize_with = "optional",
        skip_serializing_if = "Option::is_none"
    )]
    pub rendered_at: Option<String>,
    #[serde(
        default,
        deserialize_with = "optional",
        skip_serializing_if = "Option::is_none"
    )]
    pub submitted_at: Option<String>,
    #[serde(
        default,
        deserialize_with = "optional",
        skip_serializing_if = "Option::is_none"
    )]
    pub completed_at: Option<String>,
    #[serde(
        default,
        deserialize_with = "optional",
        skip_serializing_if = "Option::is_none"
    )]
    pub expected_turn: Option<SafeInt>,
    #[serde(
        default,
        deserialize_with = "optional",
        skip_serializing_if = "Option::is_none"
    )]
    pub hold_reason: Option<String>,
    #[serde(
        default,
        deserialize_with = "optional",
        skip_serializing_if = "Option::is_none"
    )]
    pub workflow_run_id: Option<String>,
    #[serde(
        default,
        deserialize_with = "optional",
        skip_serializing_if = "Option::is_none"
    )]
    pub causation_id: Option<String>,
    #[serde(
        default,
        deserialize_with = "optional",
        skip_serializing_if = "Option::is_none"
    )]
    pub broker_owned: Option<bool>,
    #[serde(
        default,
        deserialize_with = "optional",
        skip_serializing_if = "Option::is_none"
    )]
    pub launch: Option<bool>,
    #[serde(
        default,
        deserialize_with = "optional",
        skip_serializing_if = "Option::is_none"
    )]
    pub submission_kind: Option<String>,
    #[serde(
        default,
        deserialize_with = "optional",
        skip_serializing_if = "Option::is_none"
    )]
    pub wake: Option<Wake>,
}
impl Instruction {
    pub fn validate(&mut self) -> Result<()> {
        for s in [
            &self.id,
            &self.actor_session_id,
            &self.target_session_id,
            &self.message_id,
        ] {
            uuid(s)?;
        }
        for s in [
            &self.sender_session_id,
            &self.workflow_run_id,
            &self.causation_id,
        ]
        .into_iter()
        .flatten()
        {
            uuid(s)?;
        }
        for s in [&self.created_at, &self.updated_at] {
            timestamp(s)?;
        }
        for s in [&self.rendered_at, &self.submitted_at, &self.completed_at]
            .into_iter()
            .flatten()
        {
            timestamp(s)?;
        }
        self.message = js_trim(&self.message).into();
        if self.message.is_empty()
            || self.hop.0 > 9_007_199_254_740_991
            || self.expected_turn.is_some_and(|n| n.0 == 0)
            || self.submission_kind.as_ref().is_some_and(|s| s != "wake")
        {
            return Err("Invalid instruction".into());
        }
        if let Some(w) = &self.wake {
            if w.controller_id.is_empty()
                || w.cursor.0 > 9_007_199_254_740_991
                || (w.cursor.0 == 0 && w.attention_epoch.is_none())
            {
                return Err("Invalid wake".into());
            }
            for s in &w.notification_ids {
                uuid(s)?;
            }
            if let Some(s) = &w.attention_epoch {
                uuid(s)?;
            }
        }
        if let Some(r) = &self.logical_recipient
            && (r.kind != "resident" || r.key != "resident:strigoi")
        {
            return Err("Invalid recipient".into());
        }
        if let Some(a) = &self.submission_attempt {
            a.validate()?;
        }
        if let Some(w) = &mut self.withdrawal {
            w.validate()?;
        }
        if let Some(at) = &self.delivery_attempt_at {
            timestamp(at)?;
        }
        for r in self.continuations.as_deref().unwrap_or_default() {
            r.validate()?;
            if r.instruction_id != self.id
                || r.original_actor_session_id != self.actor_session_id
                || r.original_target_session_id != self.target_session_id
                || (self.logical_recipient.is_none()
                    && r.effective_target_session_id != self.target_session_id)
            {
                return Err("Continuation identity changed".into());
            }
        }
        Ok(())
    }
}

impl Instruction {
    pub fn effective_target(&self) -> &str {
        self.continuations
            .as_ref()
            .and_then(|rows| rows.last())
            .map_or(&self.target_session_id, |r| &r.effective_target_session_id)
    }
    pub fn follows(&self, prior: &Self) -> Result<()> {
        let old = prior.continuations.as_deref().unwrap_or_default();
        let new = self.continuations.as_deref().unwrap_or_default();
        if self.actor_session_id != prior.actor_session_id
            || self.target_session_id != prior.target_session_id
            || self.sender_session_id != prior.sender_session_id
            || self.message != prior.message
            || self.message_id != prior.message_id
            || self.logical_recipient != prior.logical_recipient
            || self.workflow_run_id != prior.workflow_run_id
            || self.created_at != prior.created_at
            || !new.starts_with(old)
            || (new.len() > old.len()
                && (prior.launch == Some(true)
                    || !matches!(prior.status, Status::Accepted | Status::Queued)))
        {
            return Err("Invalid instruction continuation".into());
        }
        Ok(())
    }
}
