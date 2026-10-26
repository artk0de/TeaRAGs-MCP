#[prelude_import]
#[allow(unused)]
use prelude::rust_2024::*;

extern crate alloc as alloc_crate;

#[stable(feature = "rust1", since = "1.0.0")]
pub use core::ops;
#[stable(feature = "rust1", since = "1.0.0")]
pub use core::option;
#[stable(feature = "rust1", since = "1.0.0")]
pub use core::result;
#[stable(feature = "rust1", since = "1.0.0")]
pub use alloc_crate::vec;

pub mod io;
pub mod prelude;
pub mod sync;

mod sys;
