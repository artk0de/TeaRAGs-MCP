use crate::iter::Iterator;

#[stable(feature = "rust1", since = "1.0.0")]
pub enum Option<T> {
    None,
    Some(T),
}

impl<T> Option<T> {
    /// Returns `true` if the option is a `Some` value.
    #[stable(feature = "rust1", since = "1.0.0")]
    pub const fn is_some(&self) -> bool {
        matches!(*self, Some(_))
    }

    #[stable(feature = "rust1", since = "1.0.0")]
    pub fn as_ref(&self) -> Option<&T> {
        match *self {
            Some(ref x) => Some(x),
            None => None,
        }
    }

    #[stable(feature = "rust1", since = "1.0.0")]
    pub fn map<U, F: FnOnce(T) -> U>(self, f: F) -> Option<U> {
        match self {
            Some(x) => Some(f(x)),
            None => None,
        }
    }

    #[stable(feature = "rust1", since = "1.0.0")]
    pub fn iter(&self) -> Iter<'_, T> {
        Iter { inner: self.as_ref() }
    }

    fn private_helper(&self) -> bool {
        true
    }
}

#[stable(feature = "rust1", since = "1.0.0")]
pub struct Iter<'a, A: 'a> {
    inner: Option<&'a A>,
}

#[stable(feature = "rust1", since = "1.0.0")]
impl<'a, A> Iterator for Iter<'a, A> {
    type Item = &'a A;
    fn next(&mut self) -> Option<&'a A> {
        None
    }
}

macro_rules! impl_generated {
    ($t:ident) => {
        impl<T> $t<T> {
            pub fn generated(&self) -> bool {
                true
            }
        }
    };
}

impl_generated!(Option);
