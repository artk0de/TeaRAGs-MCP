#[stable(feature = "rust1", since = "1.0.0")]
pub trait Iterator {
    type Item;
    fn next(&mut self) -> Option<Self::Item>;
}

#[stable(feature = "rust1", since = "1.0.0")]
pub trait IntoIterator {
    type Item;
    type IntoIter: Iterator<Item = Self::Item>;
    fn into_iter(self) -> Self::IntoIter;
}
