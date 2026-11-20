use blame_engine_core::ports::StoreError;
use rusqlite::ErrorCode;

/// A damaged file or a value of the wrong shape is `Corrupt`; everything else
/// (disk full, lock timeout, permissions) is `Io` and may succeed later.
pub(crate) fn sql(error: rusqlite::Error) -> StoreError {
    use rusqlite::Error::*;
    match &error {
        SqliteFailure(e, _)
            if matches!(e.code, ErrorCode::DatabaseCorrupt | ErrorCode::NotADatabase) =>
        {
            StoreError::Corrupt(error.to_string())
        }
        InvalidColumnType(..) | FromSqlConversionFailure(..) | IntegralValueOutOfRange(..) => {
            StoreError::Corrupt(error.to_string())
        }
        _ => StoreError::Io(error.to_string()),
    }
}

pub(crate) fn io(context: &str, error: std::io::Error) -> StoreError {
    StoreError::Io(format!("{context}: {error}"))
}
