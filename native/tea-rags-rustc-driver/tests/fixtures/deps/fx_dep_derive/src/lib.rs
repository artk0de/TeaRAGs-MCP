//! A dependency proc macro (outside the workspace root): its output carries call-site spans.
use proc_macro::{TokenStream, TokenTree};

fn type_name(input: TokenStream) -> String {
    let mut tokens = input.into_iter();
    while let Some(token) = tokens.next() {
        if matches!(&token, TokenTree::Ident(i) if i.to_string() == "struct") {
            return tokens.next().map(|t| t.to_string()).unwrap_or_default();
        }
    }
    String::new()
}

#[proc_macro_derive(Fail)]
pub fn derive_fail(input: TokenStream) -> TokenStream {
    let name = type_name(input);
    format!(
        "impl ::core::convert::From<i64> for {name} {{ fn from(v: i64) -> Self {{ {name}(v) }} }}"
    )
    .parse()
    .unwrap()
}
