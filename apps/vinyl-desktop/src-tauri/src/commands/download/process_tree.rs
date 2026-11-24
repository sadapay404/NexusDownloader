//! Isolate yt-dlp and its descendants before the downloader starts running.

use std::io;
use tokio::process::{Child, Command};

#[cfg(windows)]
mod platform {
    use super::*;
    use std::mem::{size_of, zeroed};
    use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
    use std::ptr::{null, null_mut};
    use std::time::Duration;
    use windows_sys::Win32::{
        Foundation::{HANDLE, INVALID_HANDLE_VALUE},
        System::{
            Diagnostics::ToolHelp::{
                CreateToolhelp32Snapshot, Thread32First, Thread32Next, TH32CS_SNAPTHREAD,
                THREADENTRY32,
            },
            JobObjects::{
                AssignProcessToJobObject, CreateJobObjectW, JobObjectBasicAccountingInformation,
                JobObjectExtendedLimitInformation, QueryInformationJobObject,
                SetInformationJobObject, TerminateJobObject,
                JOBOBJECT_BASIC_ACCOUNTING_INFORMATION, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
                JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
            },
            Threading::{OpenThread, ResumeThread, CREATE_SUSPENDED, THREAD_SUSPEND_RESUME},
        },
    };

    pub(in crate::commands::download) struct ProcessTree(OwnedHandle);

    fn check(ok: i32) -> io::Result<()> {
        if ok == 0 {
            Err(io::Error::last_os_error())
        } else {
            Ok(())
        }
    }

    /// std/Tokio do not expose the primary thread handle. CREATE_SUSPENDED
    /// guarantees that its only thread has not run or spawned a child yet.
    fn resume_primary_thread(pid: u32) -> io::Result<()> {
        // SAFETY: check all Win32 handles/return values; OwnedHandle closes handles.
        unsafe {
            let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0);
            if snapshot == INVALID_HANDLE_VALUE {
                return Err(io::Error::last_os_error());
            }
            let snapshot = OwnedHandle::from_raw_handle(snapshot);
            let mut entry: THREADENTRY32 = zeroed();
            entry.dwSize = size_of::<THREADENTRY32>() as u32;
            check(Thread32First(snapshot.as_raw_handle(), &mut entry))?;
            loop {
                if entry.th32OwnerProcessID == pid {
                    let thread = OpenThread(THREAD_SUSPEND_RESUME, 0, entry.th32ThreadID);
                    if thread.is_null() {
                        return Err(io::Error::last_os_error());
                    }
                    let thread = OwnedHandle::from_raw_handle(thread);
                    return match ResumeThread(thread.as_raw_handle()) {
                        1 => Ok(()),
                        u32::MAX => Err(io::Error::last_os_error()),
                        _ => Err(io::Error::other("Unexpected suspend count for downloader")),
                    };
                }
                entry.dwSize = size_of::<THREADENTRY32>() as u32;
                check(Thread32Next(snapshot.as_raw_handle(), &mut entry))?;
            }
        }
    }

    impl ProcessTree {
        pub(in crate::commands::download) fn spawn(cmd: &mut Command) -> io::Result<(Child, Self)> {
            // SAFETY: use fixed-size, initialized Win32 structs and owned handles.
            unsafe {
                let job = CreateJobObjectW(null(), null());
                if job.is_null() {
                    return Err(io::Error::last_os_error());
                }
                let tree = Self(OwnedHandle::from_raw_handle(job));
                let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = zeroed();
                limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                check(SetInformationJobObject(
                    job,
                    JobObjectExtendedLimitInformation,
                    (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                    size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                ))?;
                cmd.creation_flags(crate::commands::CREATE_NO_WINDOW | CREATE_SUSPENDED);
                let mut child = cmd.spawn()?;
                let process = child
                    .raw_handle()
                    .ok_or_else(|| io::Error::other("Missing process handle"))?;
                let pid = child
                    .id()
                    .ok_or_else(|| io::Error::other("Missing child PID"))?;
                if let Err(error) = check(AssignProcessToJobObject(job, process))
                    .and_then(|_| resume_primary_thread(pid))
                {
                    // If assignment failed the process is still suspended and cannot have descendants.
                    let _ = child.start_kill();
                    return Err(error);
                }
                Ok((child, tree))
            }
        }

        fn handle(&self) -> HANDLE {
            self.0.as_raw_handle()
        }

        pub(in crate::commands::download) fn terminate(&self) -> io::Result<()> {
            // SAFETY: the job remains owned by this tree until after shutdown.
            unsafe { check(TerminateJobObject(self.handle(), 1)) }
        }

        fn active_processes(&self) -> io::Result<u32> {
            // SAFETY: provide a valid buffer of the requested information class.
            unsafe {
                let mut info: JOBOBJECT_BASIC_ACCOUNTING_INFORMATION = zeroed();
                check(QueryInformationJobObject(
                    self.handle(),
                    JobObjectBasicAccountingInformation,
                    (&mut info as *mut JOBOBJECT_BASIC_ACCOUNTING_INFORMATION).cast(),
                    size_of::<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>() as u32,
                    null_mut(),
                ))?;
                Ok(info.ActiveProcesses)
            }
        }

        pub(in crate::commands::download) async fn settle(&self) {
            // Also stop any process left behind by an unexpected yt-dlp exit. A
            // failed query or termination does not release the slot prematurely.
            loop {
                if matches!(self.active_processes(), Ok(0)) {
                    return;
                }
                let _ = self.terminate();
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        }
    }

    #[cfg(test)]
    #[test]
    fn job_owns_and_stops_a_real_child_and_grandchild() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async {
            let mut cmd = Command::new("cmd.exe");
            cmd.args(["/d", "/c", "ping -n 45 127.0.0.1 >nul"]);
            cmd.kill_on_drop(true);
            let (mut child, tree) = ProcessTree::spawn(&mut cmd).unwrap();
            tokio::time::timeout(Duration::from_secs(10), async {
                while tree.active_processes().unwrap() < 2 {
                    tokio::time::sleep(Duration::from_millis(50)).await;
                }
                tree.terminate().unwrap();
                assert!(!child.wait().await.unwrap().success());
                tree.settle().await;
            })
            .await
            .unwrap();
        });
    }
}

#[cfg(unix)]
mod platform {
    use super::*;
    use std::sync::atomic::{AtomicI32, Ordering};
    use std::time::Duration;

    pub(in crate::commands::download) struct ProcessTree(AtomicI32);

    impl ProcessTree {
        pub(in crate::commands::download) fn spawn(cmd: &mut Command) -> io::Result<(Child, Self)> {
            cmd.process_group(0);
            let child = cmd.spawn()?;
            let pid = child
                .id()
                .ok_or_else(|| io::Error::other("Missing child PID"))?;
            Ok((child, Self(AtomicI32::new(pid as i32))))
        }

        pub(in crate::commands::download) fn terminate(&self) -> io::Result<()> {
            let group = self.0.load(Ordering::Acquire);
            if group == 0 {
                return Ok(());
            }
            // SAFETY: signal only the dedicated group created at spawn.
            if unsafe { libc::killpg(group, libc::SIGKILL) } == 0 {
                Ok(())
            } else {
                let error = io::Error::last_os_error();
                if error.raw_os_error() == Some(libc::ESRCH) {
                    Ok(())
                } else {
                    Err(error)
                }
            }
        }

        pub(in crate::commands::download) async fn settle(&self) {
            let group = self.0.load(Ordering::Acquire);
            let _ = self.terminate();
            while group != 0 && group_active(group) {
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            self.0.store(0, Ordering::Release);
        }
    }

    fn group_active(group: i32) -> bool {
        // Signal zero checks only whether a member of the dedicated group exists.
        if unsafe { libc::killpg(group, 0) } != 0 {
            return io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH);
        }
        // Linux can keep killed grandchildren as zombies under a subreaper. A
        // zombie cannot download or hold an output handle; don't stall on reaping.
        #[cfg(target_os = "linux")]
        if let Ok(entries) = std::fs::read_dir("/proc") {
            for entry in entries.flatten() {
                if !entry
                    .file_name()
                    .to_string_lossy()
                    .bytes()
                    .all(|b| b.is_ascii_digit())
                {
                    continue;
                }
                let Ok(stat) = std::fs::read_to_string(entry.path().join("stat")) else {
                    continue;
                };
                let Some((_, fields)) = stat.rsplit_once(") ") else {
                    continue;
                };
                let mut fields = fields.split_whitespace();
                let state = fields.next();
                let process_group = fields.nth(1).and_then(|value| value.parse::<i32>().ok());
                if process_group == Some(group) && state != Some("Z") && state != Some("X") {
                    return true;
                }
            }
            return false;
        }
        true
    }

    #[cfg(test)]
    #[test]
    fn group_owns_and_stops_a_real_child_and_grandchild() {
        use std::process::Stdio;
        use tokio::io::{AsyncBufReadExt, BufReader};
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async {
            let mut cmd = Command::new("sh");
            cmd.args(["-c", "sleep 45 & echo $!; wait"])
                .stdout(Stdio::piped())
                .kill_on_drop(true);
            let (mut child, tree) = ProcessTree::spawn(&mut cmd).unwrap();
            let group = tree.0.load(Ordering::Acquire);
            let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();
            tokio::time::timeout(Duration::from_secs(5), async {
                assert!(lines
                    .next_line()
                    .await
                    .unwrap()
                    .unwrap()
                    .parse::<u32>()
                    .is_ok());
                tree.terminate().unwrap();
                assert!(!child.wait().await.unwrap().success());
                tree.settle().await;
                assert!(!group_active(group));
            })
            .await
            .unwrap();
        });
    }

    impl Drop for ProcessTree {
        fn drop(&mut self) {
            let _ = self.terminate();
        }
    }
}

pub(super) use platform::ProcessTree;
