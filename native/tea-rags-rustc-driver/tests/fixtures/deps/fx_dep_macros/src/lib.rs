//! A dependency `macro_rules!` (outside the workspace root) that writes methods into the caller's crate.
#[macro_export]
macro_rules! flagset {
    ($name:ident) => {
        pub struct $name(pub u32);
        impl $name {
            pub fn contains(&self, other: u32) -> bool {
                self.0 & other == other
            }
        }
    };
}
