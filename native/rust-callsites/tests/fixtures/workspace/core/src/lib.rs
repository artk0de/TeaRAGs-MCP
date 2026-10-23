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

pub struct Stamp(pub u64);

impl Stamp {
    pub fn new(v: u64) -> Self {
        Stamp(v)
    }
}

pub struct Holder {
    pub f: fn(i64) -> i64,
    pub g: Box<dyn Fn(i64) -> i64>,
}

impl Holder {
    pub fn call_both(&self, x: i64) -> i64 {
        (self.f)(x) + (self.g)(x)
    }
}

pub fn with_callback(cb: impl Fn() -> i64, by_ref: &dyn Fn() -> i64) -> i64 {
    cb() + by_ref()
}

pub fn generic_callback<F: Fn(i64) -> i64>(cb: F) -> i64 {
    cb(1)
}

pub fn locals() -> u64 {
    let ts = Stamp::new;
    let mut acc = 0;
    let mut insert = |k: u64, v: u64| acc += k * v;
    insert(1, 2);
    ts(42).0 + acc
}

pub fn shared_callback(cb: &Option<std::sync::Arc<dyn Fn(i64) -> i64>>) -> i64 {
    if let Some(f) = cb {
        return f(2);
    }
    0
}
// c2
// c2
