use rusqlite::OptionalExtension;
use std::path::Path;

pub fn load(path: &Path, account: &str) -> Result<Option<String>, String> {
    if !super::preferences::account_valid(account) {
        return Err("无效的账号标识".into());
    }
    let conn = super::preferences::open(path)?;
    conn.execute_batch("CREATE TABLE IF NOT EXISTS visit_drafts (account TEXT PRIMARY KEY NOT NULL, payload TEXT NOT NULL)")
        .map_err(|_| "无法读取本机草稿")?;
    conn.query_row(
        "SELECT payload FROM visit_drafts WHERE account=?1",
        [account],
        |row| row.get(0),
    )
    .optional()
    .map_err(|_| "无法读取本机草稿".into())
}

pub fn save(path: &Path, account: &str, payload: Option<&str>) -> Result<(), String> {
    if !super::preferences::account_valid(account)
        || payload.is_some_and(|value| value.len() > 512_000)
    {
        return Err("草稿过大或账号无效".into());
    }
    let conn = super::preferences::open(path)?;
    conn.execute_batch("CREATE TABLE IF NOT EXISTS visit_drafts (account TEXT PRIMARY KEY NOT NULL, payload TEXT NOT NULL)")
        .map_err(|_| "无法保存本机草稿")?;
    if let Some(value) = payload {
        conn.execute("INSERT INTO visit_drafts(account,payload) VALUES(?1,?2) ON CONFLICT(account) DO UPDATE SET payload=excluded.payload", [account,value])
    } else {
        conn.execute("DELETE FROM visit_drafts WHERE account=?1", [account])
    }.map_err(|_| "无法保存本机草稿")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn drafts_survive_reopen_and_remain_account_scoped() {
        let path =
            std::env::temp_dir().join(format!("breathon-drafts-{}.sqlite3", std::process::id()));
        let _ = std::fs::remove_file(&path);
        super::super::preferences::save(&path, "alice", "combat").unwrap();
        save(&path, "alice", Some("draft")).unwrap();
        assert_eq!(load(&path, "alice").unwrap().as_deref(), Some("draft"));
        assert_eq!(load(&path, "bob").unwrap(), None);
        assert_eq!(
            super::super::preferences::load(&path, "alice")
                .unwrap()
                .as_deref(),
            Some("combat")
        );
        assert!(save(&path, "alice", Some(&"x".repeat(512_001))).is_err());
        save(&path, "alice", None).unwrap();
        assert_eq!(load(&path, "alice").unwrap(), None);
        std::fs::remove_file(path).unwrap();
    }
}
