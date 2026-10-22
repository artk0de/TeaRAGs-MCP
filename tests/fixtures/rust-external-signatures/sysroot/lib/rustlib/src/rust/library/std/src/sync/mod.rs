#[stable(feature = "rust1", since = "1.0.0")]
pub use self::poison::{LockResult, Mutex, MutexGuard, PoisonError};

#[unstable(feature = "sync_poison_mod", issue = "134646")]
pub mod poison;

#[stable(feature = "rust1", since = "1.0.0")]
pub mod mpsc;
