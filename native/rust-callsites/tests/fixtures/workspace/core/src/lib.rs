use std::fmt;

pub trait Store {
    fn get(&self, key: &str) -> Option<String>;
    fn describe(&self) -> String {
        format!("store:{}", self.get("name").unwrap_or_default())
    }
}

pub struct MemStore {
    items: Vec<(String, String)>,
}

impl MemStore {
    pub fn new() -> Self {
        MemStore { items: Vec::new() }
    }
    pub fn put(&mut self, k: &str, v: &str) {
        self.items.push((k.to_owned(), v.to_owned()));
    }
}

impl Store for MemStore {
    fn get(&self, key: &str) -> Option<String> {
        self.items.iter().find(|(k, _)| k == key).map(|(_, v)| v.clone())
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Point {
    pub x: i64,
    pub y: i64,
}

impl fmt::Display for Point {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "({}, {})", self.x, self.y)
    }
}

pub fn parse_num(s: &str) -> Result<i64, String> {
    s.trim().parse::<i64>().map_err(|e| e.to_string())
}

macro_rules! twice {
    ($e:expr) => {
        helper($e) + helper($e)
    };
}

fn helper(v: i64) -> i64 {
    v * 3
}

pub fn use_macro(v: i64) -> i64 {
    twice!(v.abs())
}

#[macro_export]
macro_rules! my_log {
    ($($t:tt)*) => {
        $crate::log_line(format!($($t)*))
    };
}

pub fn log_line(s: String) -> usize {
    s.len()
}

pub fn render(f: &mut fmt::Formatter<'_>, v: Option<i64>) -> fmt::Result {
    let hit = matches!(v, Some(_));
    my_log!("{}", hit);
    std::write!(f, "{}", std::matches!(v, None))
}
// c2
// c2
