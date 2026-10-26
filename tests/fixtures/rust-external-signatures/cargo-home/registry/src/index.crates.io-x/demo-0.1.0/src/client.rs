use std::sync::Arc;

pub struct Client {
    pub name: String,
    inner: Arc<Inner>,
}

struct Inner;

impl Client {
    pub fn new() -> Self {
        unimplemented!()
    }

    pub fn shared(&self) -> Arc<Client> {
        unimplemented!()
    }

    pub fn nickname(&self) -> Option<String> {
        None
    }

    pub(crate) fn internal(&self) -> Inner {
        Inner
    }
}
