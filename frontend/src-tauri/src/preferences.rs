use rusqlite::{Connection, OptionalExtension};
use std::{path::Path, time::Duration};

const STORAGE_ERROR: &str = "本机练习偏好存储暂不可用";

pub(crate) fn account_valid(account: &str) -> bool {
    !account.trim().is_empty()
        && account.chars().count() <= 100
        && !account.chars().any(char::is_control)
}

pub(crate) fn open(path: &Path) -> Result<Connection, String> {
    let mut connection = Connection::open(path).map_err(|_| STORAGE_ERROR)?;
    connection
        .busy_timeout(Duration::from_secs(2))
        .map_err(|_| STORAGE_ERROR)?;
    let transaction = connection.transaction().map_err(|_| STORAGE_ERROR)?;
    let version: u32 = transaction
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .map_err(|_| STORAGE_ERROR)?;
    match version {
        0 => transaction
            .execute_batch(
                "CREATE TABLE training_preferences (
                    account TEXT PRIMARY KEY NOT NULL,
                    experience TEXT NOT NULL CHECK (experience IN ('practice', 'combat'))
                );
                PRAGMA user_version = 1;",
            )
            .map_err(|_| STORAGE_ERROR)?,
        1 => (),
        _ => return Err("本机数据库版本较新，请更新应用".into()),
    }
    transaction.commit().map_err(|_| STORAGE_ERROR)?;
    Ok(connection)
}

pub fn load(path: &Path, account: &str) -> Result<Option<String>, String> {
    if !account_valid(account) {
        return Err("无效的本机账号标识".into());
    }
    open(path)?
        .query_row(
            "SELECT experience FROM training_preferences WHERE account = ?1",
            [account],
            |row| row.get(0),
        )
        .optional()
        .map_err(|_| STORAGE_ERROR.into())
}

pub fn save(path: &Path, account: &str, experience: &str) -> Result<(), String> {
    if !account_valid(account) || !matches!(experience, "practice" | "combat") {
        return Err("无效的本机练习偏好".into());
    }
    open(path)?
        .execute(
            "INSERT INTO training_preferences (account, experience) VALUES (?1, ?2)
             ON CONFLICT(account) DO UPDATE SET experience = excluded.experience
             WHERE training_preferences.experience <> excluded.experience",
            [account, experience],
        )
        .map_err(|_| STORAGE_ERROR)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn database() -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "breathon-preferences-{}-{}.sqlite3",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
    }

    #[test]
    fn preferences_survive_reopening_and_remain_account_scoped() {
        let path = database();
        assert_eq!(load(&path, "代表甲").unwrap(), None);
        save(&path, "代表甲", "combat").unwrap();
        assert_eq!(load(&path, "代表甲").unwrap().as_deref(), Some("combat"));
        assert_eq!(load(&path, "代表乙").unwrap(), None);
        save(&path, "代表乙", "practice").unwrap();
        save(&path, "代表甲", "practice").unwrap();
        assert_eq!(load(&path, "代表乙").unwrap().as_deref(), Some("practice"));
        assert_eq!(load(&path, "代表甲").unwrap().as_deref(), Some("practice"));
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn unchanged_preference_does_not_write_again() {
        let path = database();
        save(&path, "representative", "practice").unwrap();
        let connection = open(&path).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE writes (value TEXT);
            CREATE TRIGGER record_write AFTER UPDATE ON training_preferences
            BEGIN INSERT INTO writes VALUES (NEW.experience); END;",
            )
            .unwrap();
        save(&path, "representative", "practice").unwrap();
        save(&path, "representative", "combat").unwrap();
        let writes: i64 = connection
            .query_row("SELECT COUNT(*) FROM writes", [], |row| row.get(0))
            .unwrap();
        assert_eq!(writes, 1);
        drop(connection);
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn invalid_input_is_rejected_and_sql_is_parameterized() {
        let path = database();
        for account in ["", " ", "account\n", &"a".repeat(101)] {
            assert!(load(&path, account).is_err());
            assert!(save(&path, account, "practice").is_err());
        }
        assert!(save(&path, "代表", "unknown").is_err());
        assert!(!path.exists());
        save(&path, "'; DROP TABLE training_preferences; --", "combat").unwrap();
        assert_eq!(load(&path, "代表").unwrap(), None);
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn newer_schema_is_preserved_and_io_errors_are_redacted() {
        let path = database();
        let connection = Connection::open(&path).unwrap();
        connection.pragma_update(None, "user_version", 2).unwrap();
        drop(connection);
        assert!(save(&path, "代表", "combat").is_err());
        let connection = Connection::open(&path).unwrap();
        let version: u32 = connection
            .pragma_query_value(None, "user_version", |r| r.get(0))
            .unwrap();
        assert_eq!(version, 2);
        drop(connection);
        std::fs::remove_file(&path).unwrap();
        assert_eq!(
            load(&path.join("missing.sqlite3"), "代表").unwrap_err(),
            STORAGE_ERROR
        );
    }
}
