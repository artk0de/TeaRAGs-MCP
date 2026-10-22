use core::iter::IntoIterator;
use core::ops::Deref;

#[stable(feature = "rust1", since = "1.0.0")]
pub struct Vec<T> {
    len: usize,
    first: Option<T>,
}

#[stable(feature = "rust1", since = "1.0.0")]
pub struct IntoIter<T> {
    rest: Vec<T>,
}

impl<T> Vec<T> {
    #[stable(feature = "rust1", since = "1.0.0")]
    pub const fn new() -> Self {
        Vec { len: 0, first: None }
    }

    #[stable(feature = "rust1", since = "1.0.0")]
    pub fn push(&mut self, value: T) {}

    #[stable(feature = "rust1", since = "1.0.0")]
    pub fn first_or(self, other: T) -> Option<T> {
        None
    }
}

#[stable(feature = "rust1", since = "1.0.0")]
impl<T> IntoIterator for Vec<T> {
    type Item = T;
    type IntoIter = IntoIter<T>;
    fn into_iter(self) -> IntoIter<T> {
        IntoIter { rest: self }
    }
}

#[stable(feature = "rust1", since = "1.0.0")]
impl<'a, T> IntoIterator for &'a Vec<T> {
    type Item = &'a T;
    type IntoIter = Borrowed<'a, T>;
    fn into_iter(self) -> Borrowed<'a, T> {
        unimplemented!()
    }
}

#[stable(feature = "rust1", since = "1.0.0")]
pub struct Borrowed<'a, T> {
    rest: &'a Vec<T>,
}

#[stable(feature = "rust1", since = "1.0.0")]
impl<T> Deref for Vec<T> {
    type Target = [T];
    fn deref(&self) -> &[T] {
        &[]
    }
}
