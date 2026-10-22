pub struct Counter {
    pub total: u32,
}

impl Counter {
    pub fn bump(&mut self, by: u32) {
        self.total += by;
    }
}
