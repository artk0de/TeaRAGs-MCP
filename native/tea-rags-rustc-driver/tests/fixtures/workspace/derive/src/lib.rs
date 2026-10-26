//! A workspace proc-macro crate.
use proc_macro::{TokenStream, TokenTree};

#[proc_macro_derive(Configurable)]
pub fn derive_configurable(input: TokenStream) -> TokenStream {
    let mut tokens = input.into_iter();
    let mut name = String::new();
    while let Some(token) = tokens.next() {
        if matches!(&token, TokenTree::Ident(i) if i.to_string() == "struct") {
            name = tokens.next().map(|t| t.to_string()).unwrap_or_default();
            break;
        }
    }
    // No `format!`: the fixture pins the user-written std macro invocations it has.
    let source = String::from("impl ") + &name + " { pub fn configure(&self) -> i64 { 1 } }";
    source.parse().unwrap()
}
