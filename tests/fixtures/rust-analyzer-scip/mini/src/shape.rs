pub struct Counter {
    pub total: u32,
}

impl Counter {
    pub fn bump(&mut self, by: u32) {
        self.total += by;
    }
}

#[derive(Clone)]
pub struct Tally {
    pub n: u32,
}

pub enum Wrap {
    Boxed(u32),
}

pub fn bump_free(x: u32) -> u32 {
    x
}

pub trait Greeter {
    fn greet(&self) -> u32 {
        1
    }
}
