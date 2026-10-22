#[stable(feature = "rust1", since = "1.0.0")]
pub trait Deref {
    type Target: ?Sized;
    fn deref(&self) -> &Self::Target;
}
