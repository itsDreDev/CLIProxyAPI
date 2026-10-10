use rand::RngCore;
use serde::Serialize;
use serde_yaml::Value;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::net::{Ipv4Addr, SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};
use url::Url;

pub type Result<T> = std::result::Result<T, String>;

fn random_secret(prefix: &str) -> String {
    let mut bytes = [0u8; 32];
    rand::rng().fill_bytes(&mut bytes);
    format!(
        "{prefix}{}",
        bytes
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
    )
}

fn private_directory(path: &Path) -> Result<()> {
    fs::create_dir_all(path).map_err(|_| "Could not create the private application directory.")?;
    if fs::symlink_metadata(path)
        .map_err(|_| "Could not inspect application directory.")?
        .file_type()
        .is_symlink()
    {
        return Err("Application data must not be a symbolic link.".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))
            .map_err(|_| "Could not protect application directory.")?;
    }
    Ok(())
}

fn read_private(path: &Path) -> Result<String> {
    let metadata =
        fs::symlink_metadata(path).map_err(|_| "Could not read a private profile file.")?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err("Private profile files must be regular files.".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))
            .map_err(|_| "Could not protect a profile file.")?;
    }
    fs::read_to_string(path).map_err(|_| "Could not read a private profile file.".into())
}

// Publish a complete file without replacing an existing profile or credential.
fn create_private(path: &Path, contents: &str) -> Result<()> {
    let temporary = path.with_extension(random_secret("tmp-"));
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let result = (|| {
        let mut file = options
            .open(&temporary)
            .map_err(|_| "Could not create a private profile file.")?;
        file.write_all(contents.as_bytes())
            .and_then(|_| file.sync_all())
            .map_err(|_| "Could not save the private profile.")?;
        match fs::hard_link(&temporary, path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => Ok(()),
            Err(_) => Err("Could not publish the private profile file.".into()),
        }
    })();
    let _ = fs::remove_file(temporary);
    result
}

fn field<'a>(config: &'a Value, section: &str, key: &str, legacy: &str) -> &'a Value {
    config
        .get(section)
        .and_then(|value| value.get(key))
        .unwrap_or(&config[legacy])
}

#[derive(Clone)]
pub struct Profile {
    pub directory: PathBuf,
    pub config_path: PathBuf,
    key_path: PathBuf,
    pub port: u16,
}

fn management_field<'a>(config: &'a Value, key: &str) -> &'a Value {
    config["management"]
        .get(key)
        .unwrap_or(&config["remote-management"][key])
}

fn profile_yaml(path: &Path) -> Result<Value> {
    let mut value: Value = serde_yaml::from_str(&read_private(path)?)
        .map_err(|_| "The private configuration contains invalid YAML.")?;
    value
        .apply_merge()
        .map_err(|_| "The private configuration has invalid YAML merge keys.")?;
    Ok(value)
}

impl Profile {
    pub fn load(directory: PathBuf) -> Result<Self> {
        private_directory(&directory)?;
        let config_path = directory.join("config.yaml");
        let key_path = directory.join("management-key");
        let auth_directory = directory.join("auths");
        private_directory(&auth_directory)?;
        // Go hashes the config secret on first launch. Its original must survive separately.
        if !key_path.exists() {
            let key = if config_path.exists() {
                let config = profile_yaml(&config_path)?;
                let key = management_field(&config, "secret-key")
                    .as_str()
                    .map(str::to_owned);
                match key {
                    Some(value) if !value.is_empty() && !value.starts_with("$2") => value,
                    _ => return Err("The original management key is missing. Restore the management-key file; existing credentials were preserved.".into()),
                }
            } else {
                // bcrypt accepts at most 72 bytes; this 68-byte key retains 256 bits of entropy.
                random_secret("cpa-")
            };
            create_private(&key_path, &key)?;
        }
        let key = read_private(&key_path)?;
        if key.trim().is_empty() || key.len() > 72 || key.chars().any(char::is_whitespace) {
            return Err(
                "The saved management key is invalid; restore the original private key file."
                    .into(),
            );
        }
        if !config_path.exists() {
            let quoted = |text: &str| {
                serde_json::to_string(text).expect("String serialization is infallible")
            };
            let config = format!("# Private desktop-owned shared proxy profile.\nconfig-version: 8\nserver:\n  host: \"127.0.0.1\"\n  port: 8317\n  trusted-proxies: []\n  tls:\n    enable: false\nmanagement:\n  allow-remote: false\n  secret-key: {}\n  disable-control-panel: false\n  disable-auto-update-panel: true\naccess:\n  api-keys:\n    - {}\noauth:\n  auth-dir: {}\nrouting:\n  strategy: round-robin\nobservability:\n  usage:\n    usage-statistics-enabled: true\n", quoted(&key), quoted(&random_secret("sk-local-")), quoted(&auth_directory.to_string_lossy()));
            create_private(&config_path, &config)?;
        }
        let config = profile_yaml(&config_path)?;
        let effective_key = management_field(&config, "secret-key")
            .as_str()
            .filter(|value| !value.is_empty())
            .ok_or("Set a management secret in the private profile.")?;
        if !effective_key.starts_with("$2") && effective_key != key {
            return Err("The configuration and original management-key file disagree. Restore the matching original key.".into());
        }
        if field(&config, "server", "host", "host").as_str() != Some("127.0.0.1") {
            return Err("Desktop host mode requires server.host: 127.0.0.1.".into());
        }
        let port = field(&config, "server", "port", "port")
            .as_u64()
            .unwrap_or(8317);
        let port = u16::try_from(port)
            .ok()
            .filter(|port| *port != 0)
            .ok_or("The private proxy port is invalid.")?;
        let trusted = field(&config, "server", "trusted-proxies", "trusted-proxies");
        if !trusted.is_null()
            && trusted
                .as_sequence()
                .is_none_or(|values| !values.is_empty())
        {
            return Err("Desktop host mode requires an empty trusted-proxies list.".into());
        }
        let tls = config["server"]["tls"]
            .get("enable")
            .unwrap_or(&config["tls"]["enable"]);
        if !tls.is_null() && tls.as_bool() != Some(false) {
            return Err("Desktop host mode requires server.tls.enable: false.".into());
        }
        for option in ["allow-remote", "disable-control-panel"] {
            let value = config["management"]
                .get(option)
                .unwrap_or(&config["remote-management"][option]);
            if !value.is_null() && value.as_bool() != Some(false) {
                return Err(format!(
                    "Desktop host mode requires management.{option}: false."
                ));
            }
        }
        Ok(Self {
            directory,
            config_path,
            key_path,
            port,
        })
    }

    pub fn management_key(&self) -> Result<String> {
        read_private(&self.key_path)
    }
    pub fn origin(&self) -> String {
        format!("http://127.0.0.1:{}", self.port)
    }
}

pub fn shared_origin(input: &str) -> Result<Url> {
    let url =
        Url::parse(input.trim()).map_err(|_| "Enter the complete HTTPS Tailscale host URL.")?;
    let valid_host = url
        .host_str()
        .is_some_and(|host| host.ends_with(".ts.net") && host.len() > ".ts.net".len());
    if url.scheme() != "https"
        || !valid_host
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.path() != "/"
    {
        return Err("Use an HTTPS Tailscale origin such as https://proxy.tailnet.ts.net, without a path or credentials.".into());
    }
    Ok(url)
}

pub fn trusted_controls_url(url: &Url, development: Option<&Url>) -> bool {
    if !url.username().is_empty() || url.password().is_some() {
        return false;
    }
    let bundled = url.host_str() == Some("localhost") && url.scheme() == "tauri"
        || url.host_str() == Some("tauri.localhost") && matches!(url.scheme(), "http" | "https");
    (bundled && url.port().is_none()) || development.is_some_and(|dev| url.origin() == dev.origin())
}

pub fn provider_sign_in_url(url: &Url) -> bool {
    url.scheme() == "https"
        && url.username().is_empty()
        && url.password().is_none()
        && matches!(
            url.host_str(),
            Some("auth.openai.com" | "claude.ai" | "console.anthropic.com")
        )
}

pub fn listener_active(port: u16) -> bool {
    TcpStream::connect_timeout(
        &SocketAddr::from((Ipv4Addr::LOCALHOST, port)),
        Duration::from_millis(200),
    )
    .is_ok()
}

fn terminate_child(child: &mut Child) -> Result<()> {
    if child
        .try_wait()
        .map_err(|_| "Could not inspect the owned proxy.")?
        .is_some()
    {
        return Ok(());
    }
    #[cfg(unix)]
    {
        // The PID comes exclusively from our owned Child handle, never a listener lookup.
        unsafe {
            libc::kill(child.id() as libc::pid_t, libc::SIGTERM);
        }
        let deadline = Instant::now() + Duration::from_secs(2);
        while Instant::now() < deadline {
            if child
                .try_wait()
                .map_err(|_| "Could not inspect the owned proxy.")?
                .is_some()
            {
                return Ok(());
            }
            std::thread::sleep(Duration::from_millis(25));
        }
    }
    child
        .kill()
        .map_err(|_| "Could not stop the owned proxy process.")?;
    child
        .wait()
        .map_err(|_| "Could not wait for the owned proxy to stop.")?;
    Ok(())
}

fn isolate_profile_environment(command: &mut Command) {
    let mut names: std::collections::BTreeSet<std::ffi::OsString> =
        std::env::vars_os().map(|(name, _)| name).collect();
    names.extend(command.get_envs().map(|(name, _)| name.to_os_string()));
    for name in names {
        // Windows environment names are case-insensitive.
        let text = name.to_string_lossy().to_ascii_uppercase();
        if text == "MANAGEMENT_PASSWORD"
            || ["PGSTORE_", "GITSTORE_", "OBJECTSTORE_"]
                .iter()
                .any(|prefix| text.starts_with(prefix))
        {
            command.env_remove(name);
        }
    }
}

#[derive(Serialize, Clone)]
pub struct Status {
    pub running: bool,
    pub owned: bool,
    pub mode: &'static str,
    pub dashboard_url: String,
    pub endpoint: String,
    pub config_path: String,
    pub error: Option<String>,
}

pub struct ProcessManager {
    pub profile: Profile,
    child: Option<Child>,
    remote: Option<Url>,
    error: Option<String>,
}

impl ProcessManager {
    pub fn new(profile: Profile) -> Self {
        Self {
            profile,
            child: None,
            remote: None,
            error: None,
        }
    }

    pub fn status(&mut self) -> Status {
        if let Some(child) = self.child.as_mut() {
            match child.try_wait() {
                Ok(Some(status)) => {
                    self.child = None;
                    self.error = Some(format!("The owned proxy exited ({status})."));
                }
                Err(_) => {
                    self.error = Some("Could not inspect the owned proxy process.".into());
                }
                Ok(None) => {}
            }
        }
        let remote = self.remote.is_some();
        let origin = self
            .remote
            .as_ref()
            .map(|url| url.as_str().trim_end_matches('/').to_owned())
            .unwrap_or_else(|| self.profile.origin());
        let running = !remote && listener_active(self.profile.port);
        Status {
            running,
            owned: self.child.is_some(),
            mode: if remote { "remote" } else { "local" },
            dashboard_url: format!("{origin}/subscriptions/"),
            endpoint: format!("{origin}/v1"),
            config_path: self.profile.config_path.to_string_lossy().into_owned(),
            error: self.error.clone().or_else(|| if running && self.child.is_none() { Some("An existing listener is attached. This app will not stop it; use its original management key.".into()) } else { None }),
        }
    }

    pub fn start(&mut self, executable: &Path) -> Result<Status> {
        if self.remote.is_some() {
            return Err("Switch to This computer before starting its proxy.".into());
        }
        let current = self.status();
        if current.running || current.owned {
            return Ok(current);
        }
        // Revalidate edited profiles before starting a listener.
        self.profile = Profile::load(self.profile.directory.clone())?;
        let mut command = Command::new(executable);
        command
            .args(["--config"])
            .arg(&self.profile.config_path)
            .arg("--local-model")
            .current_dir(&self.profile.directory)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        // An inherited environment must not relax the desktop's local management policy.
        isolate_profile_environment(&mut command);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        self.spawn_owned(&mut command)?;
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            let status = self.status();
            if status.running {
                return Ok(status);
            }
            if !status.owned {
                return Err(status
                    .error
                    .unwrap_or_else(|| "The proxy could not start.".into()));
            }
            if Instant::now() >= deadline {
                self.stop()?;
                return Err("The proxy did not become ready. Check the private configuration and listener port.".into());
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    fn spawn_owned(&mut self, command: &mut Command) -> Result<()> {
        self.child = Some(command.spawn().map_err(|_| "Could not start the bundled proxy. Reinstall the desktop application or rebuild its sidecar.")?);
        self.error = None;
        Ok(())
    }

    pub fn stop(&mut self) -> Result<Status> {
        if let Some(child) = self.child.as_mut() {
            // Keep ownership when termination fails so a later stop or quit can retry.
            terminate_child(child)?;
            self.child = None;
        }
        self.error = None;
        Ok(self.status())
    }

    pub fn connect_remote(&mut self, origin: &str) -> Result<Status> {
        let remote = shared_origin(origin)?;
        self.stop()?;
        self.remote = Some(remote);
        self.error = None;
        Ok(self.status())
    }
    pub fn use_local(&mut self) -> Status {
        self.remote = None;
        self.error = None;
        self.status()
    }
    pub fn dashboard_url(&mut self) -> Result<Url> {
        let status = self.status();
        if status.mode == "local" && !status.running {
            return Err("Start the proxy before opening its dashboard.".into());
        }
        Url::parse(&status.dashboard_url).map_err(|_| "The dashboard URL is invalid.".into())
    }

    pub fn key_for_copy(&mut self) -> Result<String> {
        let status = self.status();
        if status.mode == "remote" {
            return Err("Use the management key from the shared host.".into());
        }
        if status.running && !status.owned {
            return Err(
                "An existing process owns this listener. Use that proxy's original management key."
                    .into(),
            );
        }
        self.profile.management_key()
    }

    pub fn record_error(&mut self, error: String) {
        self.error = Some(error);
    }
}

impl Drop for ProcessManager {
    fn drop(&mut self) {
        let _ = self.stop();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;
    use std::sync::{Mutex, MutexGuard};

    // A fixture releases its reservation before the Go process can bind. Keep other
    // network fixtures out of that interval and avoid TCP self-connect on Linux.
    static NETWORK_FIXTURES: Mutex<()> = Mutex::new(());

    fn network_fixture_guard() -> MutexGuard<'static, ()> {
        NETWORK_FIXTURES
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn reserve_test_listener() -> TcpListener {
        #[cfg(target_os = "linux")]
        let ephemeral_start: u16 = fs::read_to_string("/proc/sys/net/ipv4/ip_local_port_range")
            .expect("Read Linux ephemeral port range for isolated network fixtures")
            .split_whitespace()
            .next()
            .expect("Linux ephemeral port range has a lower bound")
            .parse()
            .expect("Linux ephemeral port lower bound is a port number");
        #[cfg(not(target_os = "linux"))]
        let ephemeral_start: u16 = 49152;

        // Port zero selects an ephemeral target; a readiness connection may then
        // select that same source port and connect to itself without any server.
        (1024..ephemeral_start)
            .find_map(|port| TcpListener::bind((Ipv4Addr::LOCALHOST, port)).ok())
            .expect("Reserve an unused unprivileged port below the ephemeral range")
    }

    struct Temporary(PathBuf);
    impl Temporary {
        fn new() -> Self {
            Self(std::env::temp_dir().join(random_secret("subscription-desktop-test-")))
        }
    }
    impl Drop for Temporary {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn profile_preserves_raw_key_after_go_hashes_config() {
        let temporary = Temporary::new();
        let first = Profile::load(temporary.0.clone()).unwrap();
        let key = first.management_key().unwrap();
        let config = read_private(&first.config_path)
            .unwrap()
            .replace(&key, "$2a$10$hashed-by-Go");
        fs::write(&first.config_path, &config).unwrap();
        let second = Profile::load(temporary.0.clone()).unwrap();
        assert_eq!(second.management_key().unwrap(), key);
        assert_eq!(read_private(&second.config_path).unwrap(), config);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&first.key_path).unwrap().permissions().mode() & 0o777,
                0o600
            );
            assert_eq!(
                fs::metadata(&temporary.0).unwrap().permissions().mode() & 0o777,
                0o700
            );
        }
    }

    #[test]
    fn partial_profile_recovers_config_but_never_replaces_a_lost_hashed_key() {
        let temporary = Temporary::new();
        let profile = Profile::load(temporary.0.clone()).unwrap();
        let key = profile.management_key().unwrap();
        fs::remove_file(&profile.config_path).unwrap();
        assert_eq!(
            Profile::load(temporary.0.clone())
                .unwrap()
                .management_key()
                .unwrap(),
            key
        );
        let config = read_private(&profile.config_path)
            .unwrap()
            .replace(&key, "$2a$10$hash");
        fs::write(&profile.config_path, config).unwrap();
        fs::remove_file(&profile.key_path).unwrap();
        assert!(Profile::load(temporary.0.clone()).is_err());
        assert!(!profile.key_path.exists());
    }

    #[test]
    fn remote_origins_and_controls_have_distinct_trust_boundaries() {
        assert!(shared_origin("https://host.tailnet.ts.net:8443").is_ok());
        for invalid in [
            "http://host.tailnet.ts.net",
            "https://host.ts.net.evil.com",
            "https://user@host.ts.net",
            "https://host.ts.net/subscriptions/",
            "https://host.ts.net?key=secret",
        ] {
            assert!(shared_origin(invalid).is_err(), "{invalid}");
        }
        assert!(trusted_controls_url(
            &Url::parse("tauri://localhost/index.html").unwrap(),
            None
        ));
        assert!(!trusted_controls_url(
            &Url::parse("http://127.0.0.1:8317/subscriptions/").unwrap(),
            None
        ));
        assert!(!trusted_controls_url(
            &Url::parse("http://tauri.localhost:9999/").unwrap(),
            None
        ));
        assert!(!trusted_controls_url(
            &Url::parse("tauri://user@localhost/").unwrap(),
            None
        ));
        assert!(!trusted_controls_url(
            &shared_origin("https://host.ts.net").unwrap(),
            None
        ));
        assert!(provider_sign_in_url(
            &Url::parse("https://auth.openai.com/authorize").unwrap()
        ));
        assert!(!provider_sign_in_url(
            &Url::parse("https://auth.openai.com.evil.com").unwrap()
        ));
    }

    #[test]
    fn existing_listener_is_attached_and_never_terminated() {
        let _network_guard = network_fixture_guard();
        let temporary = Temporary::new();
        let mut profile = Profile::load(temporary.0.clone()).unwrap();
        let listener = reserve_test_listener();
        profile.port = listener.local_addr().unwrap().port();
        let mut manager = ProcessManager::new(profile);
        let status = manager
            .start(Path::new("a-binary-that-does-not-exist"))
            .unwrap();
        assert!(status.running);
        assert!(!status.owned);
        assert!(manager.stop().unwrap().running);
        assert!(listener_active(listener.local_addr().unwrap().port()));
    }

    #[test]
    fn owned_process_is_reaped_without_affecting_external_listener() {
        let _network_guard = network_fixture_guard();
        let temporary = Temporary::new();
        let mut manager = ProcessManager::new(Profile::load(temporary.0.clone()).unwrap());
        let mut command = Command::new(std::env::current_exe().unwrap());
        command
            .args(["--exact", "core::tests::sidecar_fixture", "--nocapture"])
            .env("SUBSCRIPTION_PROCESS_FIXTURE", "1")
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        manager.spawn_owned(&mut command).unwrap();
        assert!(manager.status().owned);
        assert!(manager
            .connect_remote("http://untrusted.example.com")
            .is_err());
        assert!(manager.status().owned);
        assert!(
            !manager
                .connect_remote("https://host.tailnet.ts.net")
                .unwrap()
                .owned
        );
        assert!(manager.key_for_copy().is_err());
    }

    #[test]
    fn explicit_null_secret_never_falls_back_to_legacy() {
        let temporary = Temporary::new();
        let profile = Profile::load(temporary.0.clone()).unwrap();
        let mut config = profile_yaml(&profile.config_path).unwrap();
        config["remote-management"]["secret-key"] = Value::String("legacy-key".into());
        config["management"]["secret-key"] = Value::Null;
        fs::write(
            &profile.config_path,
            serde_yaml::to_string(&config).unwrap(),
        )
        .unwrap();
        fs::remove_file(&profile.key_path).unwrap();
        assert!(Profile::load(temporary.0.clone()).is_err());
        assert!(!profile.key_path.exists());
    }

    #[test]
    fn missing_sidecar_fails_without_claiming_process_ownership() {
        let _network_guard = network_fixture_guard();
        let temporary = Temporary::new();
        let profile = Profile::load(temporary.0.clone()).unwrap();
        let listener = reserve_test_listener();
        let port = listener.local_addr().unwrap().port();
        let contents = read_private(&profile.config_path)
            .unwrap()
            .replace("port: 8317", &format!("port: {port}"));
        fs::write(&profile.config_path, contents).unwrap();
        drop(listener);
        let mut manager = ProcessManager::new(Profile::load(temporary.0.clone()).unwrap());
        assert!(manager.start(Path::new("a-missing-sidecar")).is_err());
        assert!(!manager.status().owned);
    }

    #[test]
    fn inherited_storage_overrides_cannot_replace_the_private_profile() {
        let mut command = Command::new("unused-test-command");
        for name in [
            "PGSTORE_DSN",
            "GITSTORE_GIT_URL",
            "OBJECTSTORE_ENDPOINT",
            "MANAGEMENT_PASSWORD",
            "pgstore_test_override",
        ] {
            command.env(name, "test-only-value");
        }
        command.env("UNRELATED_TEST_ENV", "preserved");
        isolate_profile_environment(&mut command);
        for name in [
            "PGSTORE_DSN",
            "GITSTORE_GIT_URL",
            "OBJECTSTORE_ENDPOINT",
            "MANAGEMENT_PASSWORD",
            "pgstore_test_override",
        ] {
            assert!(
                command
                    .get_envs()
                    .any(|(key, value)| key == name && value.is_none()),
                "{name}"
            );
        }
        assert!(command
            .get_envs()
            .any(|(key, value)| key == "UNRELATED_TEST_ENV"
                && value == Some(std::ffi::OsStr::new("preserved"))));
    }

    #[test]
    #[ignore = "Requires the prepared Go sidecar"]
    fn prepared_go_sidecar_starts_stops_and_preserves_raw_key() {
        let _network_guard = network_fixture_guard();
        let suffix = if cfg!(windows) { ".exe" } else { "" };
        let executable = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("binaries")
            .join(format!(
                "subscription-desk-proxy-{}{suffix}",
                env!("SUBSCRIPTION_TARGET")
            ));
        assert!(executable.is_file(), "Prepare the desktop sidecar first");
        let temporary = Temporary::new();
        let profile = Profile::load(temporary.0.clone()).unwrap();
        let key = profile.management_key().unwrap();
        let listener = reserve_test_listener();
        let port = listener.local_addr().unwrap().port();
        fs::write(
            &profile.config_path,
            read_private(&profile.config_path)
                .unwrap()
                .replace("port: 8317", &format!("port: {port}")),
        )
        .unwrap();
        drop(listener);
        let mut manager = ProcessManager::new(Profile::load(temporary.0.clone()).unwrap());
        let status = manager.start(&executable).unwrap();
        assert!(
            status.running && status.owned,
            "Sidecar must own its reserved port {port}: running={}, owned={}, error={:?}",
            status.running,
            status.owned,
            status.error
        );
        assert_eq!(manager.key_for_copy().unwrap(), key);
        assert_eq!(
            Profile::load(temporary.0.clone())
                .unwrap()
                .management_key()
                .unwrap(),
            key
        );
        let stopped = manager.stop().unwrap();
        assert!(!stopped.running && !stopped.owned);
    }

    #[test]
    fn sidecar_fixture() {
        if std::env::var_os("SUBSCRIPTION_PROCESS_FIXTURE").is_some() {
            loop {
                std::thread::park();
            }
        }
    }
}
