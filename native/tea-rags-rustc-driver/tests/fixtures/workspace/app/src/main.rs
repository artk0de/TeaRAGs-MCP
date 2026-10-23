use fx_core::{parse_num, MemStore, Point, Store};

fn total<S: Store>(s: &S) -> usize {
    // generic: trait call cannot resolve monomorphically
    s.get("a").map(|v| v.len()).unwrap_or(0)
}

fn dynamic(s: &dyn Store) -> String {
    s.describe()
}

fn main() -> Result<(), String> {
    let mut store = MemStore::new();
    store.put("a", "1");
    let n = parse_num("42")?;
    let p = Point { x: n, y: 2 };
    let q = p.clone();
    println!("{} {} {}", p, q == p, total(&store));
    let label = store.get("a").unwrap();
    let strs: Vec<String> = vec![1, 2].iter().map(|i| i.to_string()).collect();
    let _ = Store::get(&store, "a");
    let _ = <MemStore as Store>::describe(&store);
    let _ = dynamic(&store);
    let _ = fx_core::use_macro(-3);
    let _ = Some(label.len());
    let _ = "é→x".len(); let _ = "🦀".chars().count();
    eprintln!("{}", strs.join(","));
    Ok(())
}

pub fn log_from_app() -> usize {
    fx_core::my_log!("app {}", 1)
}
// c1
// c1
