use crate::ops::Deref;
use crate::sync::{LockResult, PoisonError};
use crate::sys::sync as sys;

#[stable(feature = "rust1", since = "1.0.0")]
pub struct Mutex<T: ?Sized> {
    inner: sys::Mutex,
    data: T,
}

#[stable(feature = "rust1", since = "1.0.0")]
pub struct MutexGuard<'a, T: ?Sized + 'a> {
    lock: &'a Mutex<T>,
    pub poisoned: PoisonFlag,
}

#[stable(feature = "rust1", since = "1.0.0")]
pub struct PoisonFlag {
    pub failed: bool,
}

impl<T> Mutex<T> {
    #[stable(feature = "rust1", since = "1.0.0")]
    pub const fn new(t: T) -> Mutex<T> {
        Mutex { inner: sys::Mutex::new(), data: t }
    }
}

impl<T: ?Sized> Mutex<T> {
    #[stable(feature = "rust1", since = "1.0.0")]
    pub fn lock(&self) -> LockResult<MutexGuard<'_, T>> {
        unimplemented!()
    }

    #[stable(feature = "mutex_get_mut", since = "1.6.0")]
    pub fn get_mut(&mut self) -> LockResult<&mut T> {
        unimplemented!()
    }

    #[unstable(feature = "mutex_data_ptr", issue = "140368")]
    pub fn data_ptr(&self) -> *mut T {
        unimplemented!()
    }
}

#[cfg(miri)]
impl<T: ?Sized> Mutex<T> {
    #[unstable(feature = "miri_lock", issue = "0")]
    pub fn lock(&self) {}
}

#[stable(feature = "rust1", since = "1.0.0")]
impl<T: ?Sized> Deref for MutexGuard<'_, T> {
    type Target = T;
    fn deref(&self) -> &T {
        unimplemented!()
    }
}

#[cfg(test)]
mod tests {
    impl<T> super::Mutex<T> {
        pub fn test_only(&self) -> bool {
            true
        }
    }
}
