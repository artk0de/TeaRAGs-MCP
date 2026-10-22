mod mutex;

#[stable(feature = "rust1", since = "1.0.0")]
pub use self::mutex::{Mutex, MutexGuard};

#[stable(feature = "rust1", since = "1.0.0")]
pub struct PoisonError<T> {
    data: T,
}

#[stable(feature = "rust1", since = "1.0.0")]
pub type LockResult<T> = Result<T, PoisonError<T>>;
