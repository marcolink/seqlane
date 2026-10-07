// Embedded trusted source travels with both tsc output and Action bundles.
// The supervisor stays outside the workload cgroup so OOM cannot kill its
// accounting/cleanup path. Git and every descendant stay inside that group.
export const REVIEW_GIT_SUPERVISOR_SOURCE = String.raw`
import base64, ctypes, errno, json, os, platform, selectors, signal, subprocess, sys, time

def write_control(group, name, value):
    with open(os.path.join(group, name), "w") as handle:
        handle.write(str(value))

def read_fields(group, name):
    with open(os.path.join(group, name)) as handle:
        return {key: int(value) for key, value in (line.split() for line in handle)}

def measure(group, started):
    with open(os.path.join(group, "memory.peak")) as handle:
        peak = int(handle.read())
    return {"wallMs": (time.monotonic() - started) * 1000,
            "cpuMs": read_fields(group, "cpu.stat")["usage_usec"] / 1000,
            "peakMemoryBytes": peak, "transferBytes": 0}

def deny_network():
    # Seccomp inherits across exec/fork. No sockets reach Git; stdin is a pipe
    # or a metered pack file. Reject io_uring as an alternate networking route.
    architectures = {"x86_64": (0xc000003e, (41, 53, 425)),
                     "aarch64": (0xc00000b7, (198, 199, 425))}
    arch, calls = architectures[platform.machine()]
    class Filter(ctypes.Structure):
        _fields_ = [("code", ctypes.c_ushort), ("jt", ctypes.c_ubyte),
                    ("jf", ctypes.c_ubyte), ("k", ctypes.c_uint)]
    class Program(ctypes.Structure):
        _fields_ = [("length", ctypes.c_ushort), ("filters", ctypes.POINTER(Filter))]
    rules = [(0x20, 0, 0, 4), (0x15, 1, 0, arch), (0x06, 0, 0, 0x80000000),
             (0x20, 0, 0, 0)]
    # Reject the x32 syscall bit as well as a mismatched audit architecture.
    rules.extend([(0x35, 0, 1, 0x40000000), (0x06, 0, 0, 0x00050000 | errno.EPERM)])
    for call in calls:
        rules.extend([(0x15, 0, 1, call), (0x06, 0, 0, 0x00050000 | errno.EPERM)])
    rules.append((0x06, 0, 0, 0x7fff0000))
    filters = (Filter * len(rules))(*(Filter(*rule) for rule in rules))
    program = Program(len(rules), filters)
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(38, 1, 0, 0, 0) or libc.prctl(22, 2, ctypes.byref(program), 0, 0):
        raise OSError(ctypes.get_errno(), "seccomp setup failed")

def configure_child(group):
    os.setsid()
    write_control(group, "cgroup.procs", os.getpid())
    deny_network()

def terminate_and_reap(group, process):
    write_control(group, "cgroup.kill", 1)
    process.wait()
    # PR_SET_CHILD_SUBREAPER makes orphaned grandchildren ours to reap.
    deadline = time.monotonic() + 5
    while True:
        try:
            pid, _ = os.waitpid(-1, os.WNOHANG)
        except ChildProcessError:
            if read_fields(group, "cgroup.events")["populated"] == 0:
                return
            pid = 0
        if time.monotonic() >= deadline:
            raise RuntimeError("workload cleanup did not complete")
        if pid == 0:
            time.sleep(0.001)

def supervise(config):
    started = time.monotonic()
    limits = config["limits"]
    group = os.path.join(config["cgroupRoot"], config["groupId"])
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(36, 1, 0, 0, 0):
        raise OSError(ctypes.get_errno(), "subreaper setup failed")
    os.mkdir(group)
    process = None
    cancelled = [False]
    for sig in (signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, lambda *_: cancelled.__setitem__(0, True))
    try:
        write_control(group, "memory.max", limits["peakMemoryBytes"])
        write_control(group, "memory.swap.max", 0)
        write_control(group, "memory.oom.group", 1)
        write_control(group, "cpu.max", "1000 1000")
        write_control(group, "pids.max", 128)
        # Require all controls before exec, including the kernel peak counter.
        measure(group, started)
        for name in ("cgroup.kill", "memory.events", "cgroup.events"):
            if not os.path.exists(os.path.join(group, name)):
                raise RuntimeError("required cgroup control is missing")
        stdin = open(config["inputPath"], "rb") if config.get("inputPath") else subprocess.DEVNULL
        try:
            process = subprocess.Popen([config["executable"], *config["argv"]],
                cwd=config["cwd"], env=config["env"], stdin=stdin,
                stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                preexec_fn=lambda: configure_child(group))
        finally:
            if stdin != subprocess.DEVNULL:
                stdin.close()
        output = {"stdout": bytearray(), "stderr": bytearray()}
        total = 0
        failure = None
        with selectors.DefaultSelector() as selector:
            selector.register(process.stdout, selectors.EVENT_READ, "stdout")
            selector.register(process.stderr, selectors.EVENT_READ, "stderr")
            selector.register(sys.stdin.buffer, selectors.EVENT_READ, "parent")
            while True:
                usage = measure(group, started)
                events = read_fields(group, "memory.events")
                if cancelled[0]:
                    failure = {"kind": "cancelled"}
                    break
                if events["max"] or events["oom"] or events["oom_kill"]:
                    failure = {"kind": "limit", "resource": "peakMemoryBytes",
                               "observed": usage["peakMemoryBytes"], "limit": limits["peakMemoryBytes"]}
                    break
                # Reserve 5ms ahead of the cap for the 1ms monitor cadence.
                # Scheduling can delay the monitor; final accounting rejects
                # overshoot rather than claiming a successful bounded result.
                cpu_guard = max(0, limits["cpuMs"] - 5)
                if usage["cpuMs"] >= cpu_guard:
                    failure = {"kind": "limit", "resource": "commandCpuMs",
                               "observed": usage["cpuMs"], "limit": cpu_guard}
                    break
                if usage["wallMs"] >= limits["wallMs"]:
                    failure = {"kind": "limit", "resource": "commandWallMs",
                               "observed": usage["wallMs"], "limit": limits["wallMs"]}
                    break
                if process.poll() is not None:
                    # Kill descendants even if they escaped the process group
                    # or hold an output pipe open after their parent exited.
                    write_control(group, "cgroup.kill", 1)
                for key, _ in selector.select(0.001):
                    data = os.read(key.fd, 65536)
                    if key.data == "parent":
                        cancelled[0] = True
                        continue
                    if not data:
                        selector.unregister(key.fileobj)
                        continue
                    total += len(data)
                    if total > limits["outputBytes"]:
                        failure = {"kind": "limit", "resource": "outputBytes",
                                   "observed": total, "limit": limits["outputBytes"]}
                        break
                    output[key.data].extend(data)
                if failure or (process.poll() is not None and len(selector.get_map()) == 1):
                    break
        terminate_and_reap(group, process)
        usage = measure(group, started)
        if failure:
            return failure
        for resource, field in (("commandWallMs", "wallMs"), ("commandCpuMs", "cpuMs"),
                                ("peakMemoryBytes", "peakMemoryBytes")):
            if usage[field] > limits[field]:
                return {"kind": "limit", "resource": resource,
                        "observed": usage[field], "limit": limits[field]}
        return {"kind": "ok", "exitCode": process.returncode,
                "stdout": base64.b64encode(output["stdout"]).decode("ascii"),
                "stderr": base64.b64encode(output["stderr"]).decode("ascii"), "usage": usage}
    finally:
        if process is not None:
            terminate_and_reap(group, process)
            process.stdout.close()
            process.stderr.close()
        os.rmdir(group)

try:
    config = json.loads(sys.stdin.buffer.readline())
    result = supervise(config)
except Exception:
    result = {"kind": "error", "code": "GIT_SUPERVISOR_FAILED"}
print(json.dumps(result), flush=True)
`;
