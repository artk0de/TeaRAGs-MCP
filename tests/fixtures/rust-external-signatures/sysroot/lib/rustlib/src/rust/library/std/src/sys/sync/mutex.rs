pub struct Mutex {
    futex: u32,
}

impl Mutex {
    pub const fn new() -> Mutex {
        Mutex { futex: 0 }
    }

    pub fn lock(&self) {}
}
