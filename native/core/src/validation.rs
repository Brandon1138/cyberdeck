use crate::Result;
use serde::{Deserialize, Deserializer, Serialize};

#[derive(Clone, Copy, Debug, Default, Serialize)]
#[serde(transparent)]
pub struct SafeInt(pub u64);
impl<'de> Deserialize<'de> for SafeInt {
    fn deserialize<D: Deserializer<'de>>(d: D) -> std::result::Result<Self, D::Error> {
        let n = f64::deserialize(d)?;
        if !n.is_finite() || n.fract() != 0.0 || !(0.0..=9_007_199_254_740_991.0).contains(&n) {
            return Err(serde::de::Error::custom(
                "Expected a nonnegative safe integer",
            ));
        }
        Ok(Self(n as u64))
    }
}
pub fn optional<'de, D: Deserializer<'de>, T: Deserialize<'de>>(
    d: D,
) -> std::result::Result<Option<T>, D::Error> {
    T::deserialize(d).map(Some)
}

pub fn uuid(s: &str) -> Result<()> {
    let b = s.as_bytes();
    if s == "00000000-0000-0000-0000-000000000000" || s == "ffffffff-ffff-ffff-ffff-ffffffffffff" {
        return Ok(());
    }
    if b.len() == 36
        && b.iter().enumerate().all(|(i, c)| {
            if [8, 13, 18, 23].contains(&i) {
                *c == b'-'
            } else {
                c.is_ascii_hexdigit()
            }
        })
        && (b'1'..=b'8').contains(&b[14])
        && b"89abAB".contains(&b[19])
    {
        return Ok(());
    }
    Err("Invalid UUID".into())
}

// The z.iso.datetime() wire contract: four-digit Gregorian date, mandatory seconds,
// arbitrary fractional precision, uppercase T/Z, and no leap seconds or timezone offsets.
pub fn timestamp(s: &str) -> Result<()> {
    let b = s.as_bytes();
    if b.len() < 20
        || [4, 7].iter().any(|i| b[*i] != b'-')
        || b[10] != b'T'
        || b[13] != b':'
        || b[16] != b':'
        || b.last() != Some(&b'Z')
    {
        return Err("Invalid timestamp".into());
    }
    let digits = |start: usize, end: usize| -> Option<u32> {
        b[start..end].iter().try_fold(0, |n, c| {
            c.is_ascii_digit()
                .then_some(n * 10 + u32::from(c.wrapping_sub(b'0')))
        })
    };
    let (Some(y), Some(m), Some(d), Some(h), Some(min), Some(sec)) = (
        digits(0, 4),
        digits(5, 7),
        digits(8, 10),
        digits(11, 13),
        digits(14, 16),
        digits(17, 19),
    ) else {
        return Err("Invalid timestamp".into());
    };
    let leap = y % 4 == 0 && (y % 100 != 0 || y % 400 == 0);
    let days = match m {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if leap => 29,
        2 => 28,
        _ => 0,
    };
    let fraction = b.len() == 20
        || (b.len() >= 22 && b[19] == b'.' && b[20..b.len() - 1].iter().all(u8::is_ascii_digit));
    if d == 0 || d > days || h > 23 || min > 59 || sec > 59 || !fraction {
        return Err("Invalid timestamp".into());
    }
    Ok(())
}
