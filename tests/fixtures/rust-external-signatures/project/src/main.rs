use demo::Client;
use gitdep::Thing;
use helper::assist;
use absent_dep::Missing;
use std::sync::Mutex;

fn main() {
    let _ = (Client::new(), Thing { size: 1 }, assist(), Mutex::new(0));
}
