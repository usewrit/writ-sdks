//! Uniform list envelope (DESIGN.md §6).
//!
//! The daemon is inconsistent on the wire: some list endpoints answer
//! `{"data": [...], "count": n}`, runs answer `{"data": [...], "count": n, "total": n}`,
//! and monitors/automations/selectors answer a bare JSON array. Every list method in
//! this SDK normalizes all three into the same [`Page`] so callers never see the
//! difference.

use serde::Deserialize;

/// One page of list results, normalized across every wire envelope.
#[derive(Debug, Clone, PartialEq)]
pub struct Page<T> {
    /// The items.
    pub data: Vec<T>,
    /// Item count as reported by the daemon; synthesized as `data.len()` for
    /// bare-array endpoints (and envelopes that omit `count`).
    pub count: u64,
    /// Total matching rows across pages, when the endpoint reports one (runs);
    /// `None` otherwise.
    pub total: Option<u64>,
}

impl<T> Page<T> {
    /// Number of items in this page.
    pub fn len(&self) -> usize {
        self.data.len()
    }

    /// True when the page carries no items.
    pub fn is_empty(&self) -> bool {
        self.data.is_empty()
    }

    /// Iterate over the items.
    pub fn iter(&self) -> std::slice::Iter<'_, T> {
        self.data.iter()
    }
}

impl<T> IntoIterator for Page<T> {
    type Item = T;
    type IntoIter = std::vec::IntoIter<T>;

    fn into_iter(self) -> Self::IntoIter {
        self.data.into_iter()
    }
}

impl<'a, T> IntoIterator for &'a Page<T> {
    type Item = &'a T;
    type IntoIter = std::slice::Iter<'a, T>;

    fn into_iter(self) -> Self::IntoIter {
        self.data.iter()
    }
}

impl<'de, T: Deserialize<'de>> Deserialize<'de> for Page<T> {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        #[derive(Deserialize)]
        #[serde(untagged)]
        enum Envelope<T> {
            Wrapped {
                data: Vec<T>,
                #[serde(default)]
                count: Option<u64>,
                #[serde(default)]
                total: Option<u64>,
            },
            Bare(Vec<T>),
        }

        Ok(match Envelope::<T>::deserialize(deserializer)? {
            Envelope::Wrapped { data, count, total } => {
                let len = data.len() as u64;
                Page {
                    data,
                    count: count.unwrap_or(len),
                    total,
                }
            }
            Envelope::Bare(data) => {
                let len = data.len() as u64;
                Page {
                    data,
                    count: len,
                    total: None,
                }
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn wrapped_envelope_with_count() {
        let page: Page<serde_json::Value> =
            serde_json::from_value(json!({"data": [{"id": 1}, {"id": 2}], "count": 2})).unwrap();
        assert_eq!(page.len(), 2);
        assert_eq!(page.count, 2);
        assert_eq!(page.total, None);
    }

    #[test]
    fn wrapped_envelope_with_total() {
        let page: Page<serde_json::Value> =
            serde_json::from_value(json!({"data": [{"id": 1}], "count": 1, "total": 41})).unwrap();
        assert_eq!(page.count, 1);
        assert_eq!(page.total, Some(41));
    }

    #[test]
    fn bare_array_synthesizes_count() {
        let page: Page<serde_json::Value> =
            serde_json::from_value(json!([{"id": 1}, {"id": 2}, {"id": 3}])).unwrap();
        assert_eq!(page.count, 3);
        assert_eq!(page.total, None);
    }
}
