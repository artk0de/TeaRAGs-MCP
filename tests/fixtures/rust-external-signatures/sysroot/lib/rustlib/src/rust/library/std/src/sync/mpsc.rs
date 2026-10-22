#[stable(feature = "rust1", since = "1.0.0")]
pub struct Sender<T> {
    inner: T,
}

#[stable(feature = "rust1", since = "1.0.0")]
pub struct SyncSender<T> {
    inner: T,
}

#[stable(feature = "rust1", since = "1.0.0")]
pub struct Receiver<T> {
    inner: T,
}

#[stable(feature = "rust1", since = "1.0.0")]
pub fn channel<T>() -> (Sender<T>, Receiver<T>) {
    loop {}
}

#[stable(feature = "rust1", since = "1.0.0")]
pub fn sync_channel<T>(bound: usize) -> (SyncSender<T>, Receiver<T>) {
    loop {}
}

#[unstable(feature = "mpsc_preview", issue = "none")]
pub fn preview_channel<T>() -> Sender<T> {
    loop {}
}

fn private_channel<T>() -> Sender<T> {
    loop {}
}

#[cfg(test)]
pub fn test_channel<T>() -> Sender<T> {
    loop {}
}

impl<T> Receiver<T> {
    #[stable(feature = "rust1", since = "1.0.0")]
    pub fn split(&self) -> (Sender<T>, Receiver<T>) {
        loop {}
    }
}
