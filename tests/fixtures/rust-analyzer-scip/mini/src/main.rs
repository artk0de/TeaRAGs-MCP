mod shape;

use shape::Counter;

fn main() {
    let mut counter = Counter { total: 0 };
    counter.bump(2);
    let mut v = Vec::new();
    v.push(1);
    println!("{} {}", counter.total, v.len());
}

macro_rules! twice {
    () => {
        1
    };
}

fn extras<G: shape::Greeter>(g: G, tally: shape::Tally) {
    use shape::bump_free as bf;
    let _c2 = tally.clone();
    let _w = shape::Wrap::Boxed(3);
    let f = |x: u32| x;
    f(1);
    bf(2);
    twice!();
    g.greet();
}
