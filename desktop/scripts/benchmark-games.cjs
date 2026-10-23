'use strict';
// The helper is compiled only by this developer/build command. The application
// launches the fixed packaged executable; it never compiles or runs a script.
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const exec = promisify(execFile);
const HELPER_SOURCE = String.raw`
using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Management;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;
using System.Windows.Forms;
[assembly: System.Reflection.AssemblyTitle("Chat App Game Activity Helper")]
[assembly: System.Reflection.AssemblyDescription("Read-only, session-scoped process metadata for Chat App")]
[assembly: System.Reflection.AssemblyVersion("1.0.2.0")]
internal static class GameProcessHelper {
  private static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 4194304 };
  private static readonly HashSet<string> Known = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
  private static readonly Dictionary<string, Dictionary<string, object>> Cache = new Dictionary<string, Dictionary<string, object>>();
  private static readonly DateTime Epoch = new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc);
  private const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern IntPtr OpenProcess(uint access, [MarshalAs(UnmanagedType.Bool)] bool inherit, int pid);
  [DllImport("kernel32.dll", EntryPoint = "QueryFullProcessImageNameW", CharSet = CharSet.Unicode, SetLastError = true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool QueryFullProcessImageName(IntPtr process, uint flags, StringBuilder image, ref int length);
  [DllImport("kernel32.dll", SetLastError = true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool GetProcessTimes(IntPtr process, out long creation, out long exit, out long kernel, out long user);
  [DllImport("kernel32.dll", SetLastError = true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool CloseHandle(IntPtr handle);
  [DllImport("user32.dll", SetLastError = true)]
  private static extern IntPtr SendMessageTimeout(IntPtr window, uint message, IntPtr wParam, IntPtr lParam, uint flags, uint timeout, out IntPtr result);
  [DllImport("user32.dll", EntryPoint = "GetClassLongPtrW")]
  private static extern IntPtr GetClassLongPtr(IntPtr window, int index);
  private static string WindowIcon(IntPtr window) {
    try {
      IntPtr icon;
      // Read the owning window's actual large icon with a strict timeout. A
      // hung game cannot block the scanner, and no process memory is read.
      SendMessageTimeout(window, 0x7F, new IntPtr(1), IntPtr.Zero, 2, 40, out icon);
      if (icon == IntPtr.Zero) icon = GetClassLongPtr(window, -14);
      if (icon == IntPtr.Zero) SendMessageTimeout(window, 0x7F, IntPtr.Zero, IntPtr.Zero, 2, 40, out icon);
      if (icon == IntPtr.Zero) icon = GetClassLongPtr(window, -34);
      if (icon == IntPtr.Zero) return "";
      using (var copy = (Icon)Icon.FromHandle(icon).Clone())
      using (var bitmap = copy.ToBitmap())
      using (var scaled = new Bitmap(bitmap, new Size(48, 48)))
      using (var bytes = new MemoryStream()) {
        scaled.Save(bytes, ImageFormat.Png);
        if (bytes.Length <= 24000) return "data:image/png;base64," + Convert.ToBase64String(bytes.ToArray());
      }
    } catch { }
    return "";
  }
  private static bool IsMinecraft(int pid) {
    try {
      var options = new EnumerationOptions { ReturnImmediately = false, Timeout = TimeSpan.FromSeconds(3) };
      using (var query = new ManagementObjectSearcher("root\\CIMV2", "SELECT CommandLine FROM Win32_Process WHERE ProcessId = " + pid, options))
      using (var rows = query.Get()) {
        foreach (ManagementObject row in rows) using (row) {
          // Classify locally. JVM arguments can contain session credentials;
          // neither the cache nor the IPC response keeps the command line.
          return Regex.IsMatch(Convert.ToString(row["CommandLine"]) ?? "", @"(?:net\.minecraft|net\.fabricmc\.loader|cpw\.mods\.(?:modlauncher|bootstraplauncher)|--assetIndex\s+\S+.*--(?:gameDir|assetsDir)|net\.digitalingot\.feather|(?:dawn|feather)[\\/.])", RegexOptions.IgnoreCase);
        }
      }
    } catch { }
    return false;
  }
  private static string ClientWindowIcon(IntPtr window, string executable) {
    var image = WindowIcon(window);
    if (image.Length == 0) return "";
    try {
      // A client may set real launcher art on its JVM window. Accept that art
      // only if it differs from the JVM executable's own generic mascot.
      using (var icon = Icon.ExtractAssociatedIcon(executable))
      using (var bitmap = icon.ToBitmap())
      using (var scaled = new Bitmap(bitmap, new Size(48, 48)))
      using (var bytes = new MemoryStream()) {
        scaled.Save(bytes, ImageFormat.Png);
        if (image == "data:image/png;base64," + Convert.ToBase64String(bytes.ToArray())) return "";
      }
      return image;
    } catch { return ""; }
  }
  private static bool HasFunkinAssets(string executable) {
    // Fixed asset signatures recognize renamed mods without a finite mod-name
    // list. Check only beside a visible executable, once per process lifetime.
    try {
      string root = Path.GetDirectoryName(executable);
      foreach (string prefix in new string[] { "assets", "assets/preload", "assets/shared" }) {
        string assets = Path.Combine(root, prefix.Replace('/', Path.DirectorySeparatorChar));
        bool charts = Directory.Exists(Path.Combine(assets, "data")) || Directory.Exists(Path.Combine(assets, "songs"));
        bool fnfArt = File.Exists(Path.Combine(assets, "images/NOTE_assets.xml")) || File.Exists(Path.Combine(assets, "images/noteSplashes.xml")) || File.Exists(Path.Combine(assets, "images/alphabet.xml")) && Directory.Exists(Path.Combine(assets, "images/icons"));
        if (charts && fnfArt) return true;
      }
    } catch { }
    return false;
  }
  private static List<Dictionary<string, object>> Scan(int session) {
    var result = new List<Dictionary<string, object>>();
    var present = new HashSet<string>();
    foreach (var process in Process.GetProcesses()) {
      using (process) try {
        if (process.SessionId != session) continue;
        string identity = process.Id.ToString();
        present.Add(identity);
        bool visible = false;
        try { visible = process.MainWindowHandle != IntPtr.Zero; } catch { }
        // A tray/background process is not a playing session. Do not open its
        // executable module or inspect its JVM arguments merely to discard it.
        if (!visible) continue;
        string name = process.ProcessName.ToLowerInvariant() + ".exe";
        bool java = name == "java.exe" || name == "javaw.exe";
        Dictionary<string, object> entry = null;
        // Both documented APIs accept QUERY_LIMITED_INFORMATION. MainModule
        // would request module/memory access simply to find the executable.
        // Use one read-only handle for identity and path, closed on every path.
        IntPtr handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, process.Id);
        try {
          double startedAt = 0;
          long creation, exit, kernel, user;
          if (handle != IntPtr.Zero && GetProcessTimes(handle, out creation, out exit, out kernel, out user)) {
            try { startedAt = (DateTime.FromFileTimeUtc(creation) - Epoch).TotalMilliseconds; } catch { }
          }
          if (startedAt == 0 || !Cache.TryGetValue(identity, out entry) || Convert.ToDouble(entry["startedAt"]) != startedAt) {
            string imagePath = "";
            if (handle != IntPtr.Zero) {
              var image = new StringBuilder(32768); int length = image.Capacity;
              if (QueryFullProcessImageName(handle, 0, image, ref length)) imagePath = image.ToString();
            }
            entry = new Dictionary<string, object> {
              { "name", name }, { "path", imagePath }, { "commandLine", "" }, { "isMinecraft", java && IsMinecraft(process.Id) },
              { "startedAt", startedAt }, { "pid", process.Id }
            };
            entry["hasFunkinAssets"] = !java && HasFunkinAssets(imagePath);
            if (startedAt > 0) Cache[identity] = entry;
          }
        } finally { if (handle != IntPtr.Zero) CloseHandle(handle); }
        entry["visible"] = visible;
        if (java && Regex.IsMatch(process.MainWindowTitle ?? "", @"^(?:Dawn\s*\(Feather\)|(?:Dawn|Feather|Lunar|Badlion|LabyMod|Meteor|LiquidBounce)(?: Client)?(?:\s|$)|Minecraft(?:\s|$))", RegexOptions.IgnoreCase)) entry["isMinecraft"] = true;
        // Window titles are used only to recognize named Minecraft clients.
        // Arbitrary titles (which may contain private text) never leave here.
        if (Convert.ToBoolean(entry["isMinecraft"])) {
          string title = process.MainWindowTitle ?? "";
          var client = Regex.Match(title, @"\b(Dawn|Feather|Lunar|Badlion|LabyMod|Meteor|LiquidBounce)\b", RegexOptions.IgnoreCase);
          entry["minecraftClient"] = client.Success ? client.Groups[1].Value + " Client" : "";
          if (Convert.ToString(entry["minecraftClient"]).Length > 0 && !entry.ContainsKey("clientIcon")) entry["clientIcon"] = ClientWindowIcon(process.MainWindowHandle, Convert.ToString(entry["path"]));
        }
        // Recognize renamed FNF mod executables from the game's own title.
        // Only a recognized game title is returned; unrelated app titles stay
        // private and are never mistaken for games.
        string gameTitle = process.MainWindowTitle ?? "";
        bool fnf = !Regex.IsMatch(name, @"^(?:chrome|msedge|firefox|opera|brave|explorer|code|notepad)\.exe$", RegexOptions.IgnoreCase) &&
          (Convert.ToBoolean(entry["hasFunkinAssets"]) || Regex.IsMatch(name, @"^(?:(?:fnf|funkin)(?:[-_ .].*)?|(?:psych|codename|kade)[ _-]*engine|friday[ _-]+night[ _-]+funkin)\.exe$", RegexOptions.IgnoreCase) ||
           Regex.IsMatch(gameTitle, @"^(?:Friday Night Funkin['’]?|FNF|(?:Psych|Codename|Kade)\s*Engine)(?:\s|\s*[-:!]|$)", RegexOptions.IgnoreCase));
        entry["isFridayNightFunkin"] = fnf;
        if (fnf) {
          entry["gameTitle"] = gameTitle.Substring(0, Math.Min(gameTitle.Length, 120));
          if (!entry.ContainsKey("icon")) entry["icon"] = WindowIcon(process.MainWindowHandle);
        } else {
          entry.Remove("gameTitle");
        }
        result.Add(entry);
      } catch { }
    }
    foreach (var key in new List<string>(Cache.Keys)) if (!present.Contains(key)) Cache.Remove(key);
    return result;
  }
  [STAThread]
  public static void Main(string[] args) {
    Console.InputEncoding = new UTF8Encoding(false);
    Console.OutputEncoding = new UTF8Encoding(false);
    if (args.Length == 1 && args[0] == "--clipboard-files") {
      try {
        var files = new List<string>();
        foreach (string file in Clipboard.GetFileDropList()) { files.Add(file); if (files.Count > 12) break; }
        Console.WriteLine(Json.Serialize(files));
      } catch { Console.Error.WriteLine("Clipboard unavailable."); Environment.ExitCode = 1; }
      return;
    }
    if (args.Length != 0) { Environment.ExitCode = 2; return; }
    int session;
    using (var self = Process.GetCurrentProcess()) session = self.SessionId;
    string configuration = Console.ReadLine();
    if (configuration == null || configuration.Length > 65536) return;
    try {
      var value = Json.Deserialize<Dictionary<string, object>>(configuration);
      var names = value.ContainsKey("names") ? value["names"] as IEnumerable : null;
      if (names != null) foreach (var name in names) Known.Add(Convert.ToString(name));
    } catch { return; }
    string line;
    while ((line = Console.ReadLine()) != null) {
      object id = null;
      try {
        if (line.Length > 4096) return;
        var request = Json.Deserialize<Dictionary<string, object>>(line);
        if (!request.TryGetValue("id", out id)) continue;
        var started = Stopwatch.StartNew();
        var processes = Scan(session);
        Console.WriteLine(Json.Serialize(new { id = id, processes = processes, scanMs = started.Elapsed.TotalMilliseconds }));
      } catch { Console.WriteLine(Json.Serialize(new { id = id, error = "process-scan-failed" })); }
    }
  }
}
`;

async function buildHelper() {
  if (process.platform !== 'win32') throw new Error('Build the Windows game helper on Windows.');
  const framework = path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319');
  const compiler = path.join(framework, 'csc.exe');
  await fs.access(compiler);
  const temporaryRoot = path.resolve(os.tmpdir());
  const scratch = await fs.mkdtemp(path.join(temporaryRoot, 'chat-game-helper-build-'));
  const source = path.join(scratch, 'GameProcessHelper.cs');
  const output = path.resolve(__dirname, '../helpers/game-process-helper.exe');
  try {
    await fs.writeFile(source, HELPER_SOURCE, 'utf8');
    await exec(compiler, ['/nologo', '/target:exe', '/platform:x64', '/optimize+', '/debug-', '/out:' + output,
      '/reference:' + path.join(framework, 'System.Web.Extensions.dll'), '/reference:' + path.join(framework, 'System.Management.dll'), '/reference:' + path.join(framework, 'System.Windows.Forms.dll'), '/reference:' + path.join(framework, 'System.Drawing.dll'), source],
    { windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024 });
    console.log('Built fixed Chat App game activity helper.');
  } catch (error) {
    throw new Error(String(error.stdout || error.message || 'Helper compilation failed'));
  } finally {
    const cleanupPath = path.resolve(scratch);
    if (!cleanupPath.startsWith(temporaryRoot + path.sep) || !path.basename(cleanupPath).startsWith('chat-game-helper-build-')) throw new Error('Invalid helper build cleanup path.');
    await fs.rm(cleanupPath, { recursive: true, force: true });
  }
}

async function benchmark() {
  const { createProcessScanner, detectGames } = require('../games.cjs');
  const scanner = createProcessScanner();
  const durations = []; let startupMs, candidateCount, detectedGames;
  try {
    for (let i = 0; i < 7; i++) {
      const start = performance.now();
      const processes = await scanner.read();
      const elapsed = performance.now() - start;
      if (i) durations.push(elapsed); else startupMs = +elapsed.toFixed(2);
      candidateCount = processes.length; detectedGames = detectGames(processes, []).map(game => game.title);
    }
    const sorted = durations.slice().sort((a, b) => a - b);
    console.log(JSON.stringify({ measuredAt: new Date().toISOString(), startupMs, minMs: +sorted[0].toFixed(2), medianMs: +sorted[3].toFixed(2), maxMs: +sorted.at(-1).toFixed(2), subprocessesPerSixPolls: 1, candidateCount, games: detectedGames, pollingIntervalMs: 3000 }, null, 2));
  } finally { scanner.stop(); }
}
// electron-builder's portable NSIS bootstrap is x86 even around an x64 app.
// This small managed AMD64 bootstrap uses only standard .NET file/ZIP/process
// APIs. It extracts the unmodified x64 package once per content hash and starts
// its normal Electron entry point; updates still belong to updater.cjs.
const PORTABLE_SOURCE = String.raw`
using System;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Threading;
using System.Windows.Forms;
[assembly: AssemblyTitle("Chat App")]
[assembly: AssemblyDescription("64-bit Chat App portable launcher")]
[assembly: AssemblyCompany("Chat App")]
[assembly: AssemblyProduct("Chat App")]
[assembly: AssemblyVersion("1.7.4.0")]
[assembly: AssemblyFileVersion("1.7.4.0")]
internal static class ChatPortable {
  private const string Release = "__RELEASE__";
  [STAThread]
  public static void Main() {
    try {
      if (!Environment.Is64BitProcess) throw new InvalidOperationException("Chat App requires 64-bit Windows.");
      string parent = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Chat App", "runtime");
      string root = Path.Combine(parent, Release);
      string executable = Path.Combine(root, "Chat App.exe");
      Directory.CreateDirectory(parent);
      using (var gate = new Mutex(false, "Local\\ChatAppPortable-" + Release)) {
        bool acquired = false;
        try {
          try { acquired = gate.WaitOne(TimeSpan.FromMinutes(2)); } catch (AbandonedMutexException) { acquired = true; }
          if (!acquired) throw new TimeoutException("Another Chat App launch is still preparing its files. Please try again.");
          if (!File.Exists(executable) || !File.Exists(Path.Combine(root, ".ready"))) {
            string staging = Path.Combine(parent, Release + "-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(staging);
            try {
              using (var payload = Assembly.GetExecutingAssembly().GetManifestResourceStream("chat-app.zip"))
              using (var archive = new ZipArchive(payload, ZipArchiveMode.Read)) {
                string prefix = Path.GetFullPath(staging) + Path.DirectorySeparatorChar;
                foreach (var entry in archive.Entries) {
                  string destination = Path.GetFullPath(Path.Combine(staging, entry.FullName));
                  if (!destination.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException("Invalid bundled path.");
                  if (String.IsNullOrEmpty(entry.Name)) { Directory.CreateDirectory(destination); continue; }
                  Directory.CreateDirectory(Path.GetDirectoryName(destination));
                  using (var input = entry.Open()) using (var output = new FileStream(destination, FileMode.CreateNew, FileAccess.Write)) input.CopyTo(output);
                }
              }
              File.WriteAllText(Path.Combine(staging, ".ready"), Release);
              if (Directory.Exists(root)) {
                // Only this exact, versioned incomplete cache is eligible for
                // replacement. A running complete release is never modified.
                string checkedRoot = Path.GetFullPath(root);
                if (!checkedRoot.StartsWith(Path.GetFullPath(parent) + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase) || Path.GetFileName(checkedRoot) != Release) throw new InvalidDataException("Invalid runtime cache.");
                Directory.Delete(checkedRoot, true);
              }
              Directory.Move(staging, root);
            } catch {
              string checkedStaging = Path.GetFullPath(staging);
              if (checkedStaging.StartsWith(Path.GetFullPath(parent) + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase) && Path.GetFileName(checkedStaging).StartsWith(Release + "-", StringComparison.Ordinal)) {
                try { Directory.Delete(checkedStaging, true); } catch { }
              }
              throw;
            }
          }
        } finally { if (acquired) gate.ReleaseMutex(); }
      }
      var start = new ProcessStartInfo(executable) { WorkingDirectory = root, UseShellExecute = false };
      start.EnvironmentVariables["PORTABLE_EXECUTABLE_FILE"] = Assembly.GetExecutingAssembly().Location;
      start.EnvironmentVariables["PORTABLE_EXECUTABLE_DIR"] = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
      Process.Start(start);
    } catch (Exception error) {
      MessageBox.Show("Chat App could not start.\n\n" + error.Message, "Chat App", MessageBoxButtons.OK, MessageBoxIcon.Error);
      Environment.ExitCode = 1;
    }
  }
}
`;
async function buildPortable() {
  if (process.platform !== 'win32') throw new Error('Build the portable executable on 64-bit Windows.');
  const crypto = require('node:crypto');
  const outputRoot = path.resolve(process.env.CHAT_APP_DIST || path.join(__dirname, '../dist'));
  const unpacked = path.join(outputRoot, 'win-unpacked');
  const runtime = await fs.readFile(path.join(unpacked, 'Chat App.exe'));
  if (runtime.readUInt16LE(runtime.readUInt32LE(60) + 4) !== 0x8664) throw new Error('Packaged runtime is not AMD64.');
  const framework = path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319');
  const temporaryRoot = path.resolve(os.tmpdir()), scratch = await fs.mkdtemp(path.join(temporaryRoot, 'chat-portable-build-'));
  try {
    const zip = path.join(scratch, 'chat-app.zip');
    const sevenZip = await require('app-builder-lib/out/toolsets/7zip').getPath7za();
    await exec(sevenZip, ['a', '-tzip', '-mx=5', '-mmt=2', zip, '.'], { cwd: unpacked, windowsHide: true, timeout: 300000, maxBuffer: 1024 * 1024 });
    const hash = crypto.createHash('sha256').update(await fs.readFile(zip)).digest('hex');
    const source = path.join(scratch, 'ChatPortable.cs');
    await fs.writeFile(source, PORTABLE_SOURCE.replace('__RELEASE__', hash), 'utf8');
    const output = path.join(outputRoot, 'Chat App.exe');
    await exec(path.join(framework, 'csc.exe'), ['/nologo', '/target:winexe', '/platform:x64', '/optimize+', '/debug-', '/out:' + output,
      '/win32icon:' + path.resolve(__dirname, '../assets/chat-app.ico'), '/resource:' + zip + ',chat-app.zip',
      '/reference:' + path.join(framework, 'System.IO.Compression.dll'), '/reference:' + path.join(framework, 'System.Windows.Forms.dll'), source],
    { windowsHide: true, timeout: 120000, maxBuffer: 1024 * 1024 });
    const launcher = await fs.readFile(output);
    if (launcher.readUInt16LE(launcher.readUInt32LE(60) + 4) !== 0x8664) throw new Error('Portable launcher is not AMD64.');
    console.log(JSON.stringify({ output, architecture: 'AMD64', runtimeArchitecture: 'AMD64', sha256: crypto.createHash('sha256').update(launcher).digest('hex'), runtimeCache: hash }));
  } catch (error) { throw new Error(String(error.stdout || error.message)); }
  finally {
    const cleanup = path.resolve(scratch);
    if (!cleanup.startsWith(temporaryRoot + path.sep) || !path.basename(cleanup).startsWith('chat-portable-build-')) throw new Error('Invalid portable build cleanup path.');
    await fs.rm(cleanup, { recursive: true, force: true });
  }
}
module.exports = { HELPER_SOURCE, PORTABLE_SOURCE, buildHelper, buildPortable };
if (require.main === module) (process.argv.includes('--build-helper') ? buildHelper() : process.argv.includes('--package-x64') ? buildPortable() : benchmark()).catch(error => { console.error(error.message); process.exitCode = 1; });
