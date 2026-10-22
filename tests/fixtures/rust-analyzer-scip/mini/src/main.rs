mod shape;

use shape::Counter;

fn main() {
    let mut counter = Counter { total: 0 };
    counter.bump(2);
    let mut v = Vec::new();
    v.push(1);
    println!("{} {}", counter.total, v.len());
}
