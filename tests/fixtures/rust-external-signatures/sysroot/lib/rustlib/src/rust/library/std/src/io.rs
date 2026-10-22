#[stable(feature = "rust1", since = "1.0.0")]
pub struct Error {
    repr: u8,
}

#[stable(feature = "rust1", since = "1.0.0")]
pub type Result<T> = core::result::Result<T, Error>;

#[stable(feature = "rust1", since = "1.0.0")]
pub struct Stdin {
    _p: (),
}

pub struct UnixHandle;
pub struct WindowsHandle;

#[stable(feature = "rust1", since = "1.0.0")]
pub struct Output {
    pub status: Stdin,
    pub error: Option<Error>,
    buffer: Error,
    pub(crate) internal: Error,
}

impl Error {
    #[stable(feature = "rust1", since = "1.0.0")]
    pub fn description(&self) -> &str {
        ""
    }
}

impl Stdin {
    #[stable(feature = "rust1", since = "1.0.0")]
    pub fn try_clone(&self) -> Result<Stdin> {
        unimplemented!()
    }
}

#[cfg(unix)]
impl Stdin {
    #[stable(feature = "rust1", since = "1.0.0")]
    pub fn handle(&self) -> UnixHandle {
        UnixHandle
    }

    #[stable(feature = "rust1", since = "1.0.0")]
    pub fn output(self) -> Output {
        unimplemented!()
    }
}

#[cfg(windows)]
impl Stdin {
    #[stable(feature = "rust1", since = "1.0.0")]
    pub fn handle(&self) -> WindowsHandle {
        WindowsHandle
    }

    #[stable(feature = "rust1", since = "1.0.0")]
    pub fn output(self) -> Output {
        unimplemented!()
    }
}
