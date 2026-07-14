param(
  [Parameter(Mandatory = $true, Position = 0)]
  [string]$InvocationPayload
)

$ErrorActionPreference = "Stop"

try {
  if (
    $InvocationPayload.Length -gt 1398104 -or
    $InvocationPayload -notmatch '^[A-Za-z0-9+/]+={0,2}$'
  ) {
    throw "Invalid invocation payload"
  }
  $utf8 = [System.Text.UTF8Encoding]::new($false, $true)
  $json = $utf8.GetString([Convert]::FromBase64String($InvocationPayload))
  $invocation = $json | ConvertFrom-Json
  $propertyNames = @($invocation.PSObject.Properties.Name) | Sort-Object
  if (
    ($propertyNames -join ',') -ne 'arguments,executable,version' -or
    $invocation.version -ne 1 -or
    $invocation.executable -isnot [string] -or
    [string]::IsNullOrEmpty($invocation.executable) -or
    $invocation.executable.Contains([char]0) -or
    $invocation.arguments -isnot [System.Array]
  ) {
    throw "Invalid invocation schema"
  }
  $Executable = [string]$invocation.executable
  $CommandArguments = [string[]]@($invocation.arguments)
  foreach ($argument in @($invocation.arguments)) {
    if ($argument -isnot [string] -or $argument.Contains([char]0)) {
      throw "Invalid invocation argument"
    }
  }
} catch {
  [Console]::Error.WriteLine("Managed Windows job failed")
  exit 125
}

Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class CoredotWindowsJobRunner
{
    private const uint CREATE_SUSPENDED = 0x00000004;
    private const uint INFINITE = 0xffffffff;
    private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
    private const int JobObjectBasicAccountingInformation = 1;
    private const int JobObjectExtendedLimitInformation = 9;

    [StructLayout(LayoutKind.Sequential)]
    private struct STARTUPINFO
    {
        public int cb;
        public IntPtr lpReserved;
        public IntPtr lpDesktop;
        public IntPtr lpTitle;
        public uint dwX;
        public uint dwY;
        public uint dwXSize;
        public uint dwYSize;
        public uint dwXCountChars;
        public uint dwYCountChars;
        public uint dwFillAttribute;
        public uint dwFlags;
        public ushort wShowWindow;
        public ushort cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput;
        public IntPtr hStdOutput;
        public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PROCESS_INFORMATION
    {
        public IntPtr hProcess;
        public IntPtr hThread;
        public uint dwProcessId;
        public uint dwThreadId;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IO_COUNTERS
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_ACCOUNTING_INFORMATION
    {
        public ulong TotalUserTime;
        public ulong TotalKernelTime;
        public ulong ThisPeriodTotalUserTime;
        public ulong ThisPeriodTotalKernelTime;
        public uint TotalPageFaultCount;
        public uint TotalProcesses;
        public uint ActiveProcesses;
        public uint TotalTerminatedProcesses;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateJobObject(IntPtr attributes, string name);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CreateProcess(
        string applicationName,
        StringBuilder commandLine,
        IntPtr processAttributes,
        IntPtr threadAttributes,
        bool inheritHandles,
        uint creationFlags,
        IntPtr environment,
        string currentDirectory,
        ref STARTUPINFO startupInfo,
        out PROCESS_INFORMATION processInformation);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(
        IntPtr job,
        int informationClass,
        IntPtr information,
        uint informationLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool QueryInformationJobObject(
        IntPtr job,
        int informationClass,
        out JOBOBJECT_BASIC_ACCOUNTING_INFORMATION information,
        uint informationLength,
        IntPtr returnLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateJobObject(IntPtr job, uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateProcess(IntPtr process, uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint ResumeThread(IntPtr thread);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    public static int Run(string executable, string[] arguments)
    {
        IntPtr job = IntPtr.Zero;
        PROCESS_INFORMATION process = new PROCESS_INFORMATION();
        bool assignedToJob = false;
        bool childCreated = false;
        try
        {
            job = CreateJobObject(IntPtr.Zero, null);
            CheckHandle(job);
            ConfigureKillOnClose(job);

            STARTUPINFO startup = new STARTUPINFO();
            startup.cb = Marshal.SizeOf(typeof(STARTUPINFO));
            StringBuilder commandLine = new StringBuilder(BuildCommandLine(executable, arguments));
            if (!CreateProcess(
                executable,
                commandLine,
                IntPtr.Zero,
                IntPtr.Zero,
                false,
                CREATE_SUSPENDED,
                IntPtr.Zero,
                null,
                ref startup,
                out process))
            {
                ThrowLastError();
            }
            childCreated = true;

            if (!AssignProcessToJobObject(job, process.hProcess)) ThrowLastError();
            assignedToJob = true;
            if (ResumeThread(process.hThread) == UInt32.MaxValue) ThrowLastError();
            CloseHandle(process.hThread);
            process.hThread = IntPtr.Zero;
            if (WaitForSingleObject(process.hProcess, INFINITE) == UInt32.MaxValue)
            {
                ThrowLastError();
            }
            uint exitCode;
            if (!GetExitCodeProcess(process.hProcess, out exitCode)) ThrowLastError();
            CloseHandle(process.hProcess);
            process.hProcess = IntPtr.Zero;

            if (!TerminateJobObject(job, 125)) ThrowLastError();
            WaitForEmptyJob(job);
            return unchecked((int)exitCode);
        }
        finally
        {
            if (assignedToJob && job != IntPtr.Zero)
            {
                TerminateJobObject(job, 125);
            }
            else if (childCreated && process.hProcess != IntPtr.Zero)
            {
                TerminateProcess(process.hProcess, 125);
                WaitForSingleObject(process.hProcess, 5000);
            }
            if (process.hThread != IntPtr.Zero) CloseHandle(process.hThread);
            if (process.hProcess != IntPtr.Zero) CloseHandle(process.hProcess);
            if (job != IntPtr.Zero) CloseHandle(job);
        }
    }

    private static void ConfigureKillOnClose(IntPtr job)
    {
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION information =
            new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
        information.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        int size = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
        IntPtr pointer = Marshal.AllocHGlobal(size);
        try
        {
            Marshal.StructureToPtr(information, pointer, false);
            if (!SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                pointer,
                unchecked((uint)size)))
            {
                ThrowLastError();
            }
        }
        finally
        {
            Marshal.FreeHGlobal(pointer);
        }
    }

    private static void WaitForEmptyJob(IntPtr job)
    {
        int size = Marshal.SizeOf(typeof(JOBOBJECT_BASIC_ACCOUNTING_INFORMATION));
        for (int attempt = 0; attempt < 200; attempt++)
        {
            JOBOBJECT_BASIC_ACCOUNTING_INFORMATION information;
            if (!QueryInformationJobObject(
                job,
                JobObjectBasicAccountingInformation,
                out information,
                unchecked((uint)size),
                IntPtr.Zero))
            {
                ThrowLastError();
            }
            if (information.ActiveProcesses == 0) return;
            Thread.Sleep(25);
        }
        throw new TimeoutException("Managed Windows job cleanup timed out");
    }

    private static string BuildCommandLine(string executable, string[] arguments)
    {
        StringBuilder result = new StringBuilder(QuoteArgument(executable));
        if (arguments == null) return result.ToString();
        foreach (string argument in arguments)
        {
            result.Append(' ');
            result.Append(QuoteArgument(argument ?? String.Empty));
        }
        return result.ToString();
    }

    private static string QuoteArgument(string argument)
    {
        if (argument.Length > 0 &&
            argument.IndexOf('"') < 0 &&
            argument.IndexOfAny(new char[] { ' ', '\t', '\n', '\r', '\v', '\f' }) < 0)
        {
            return argument;
        }

        StringBuilder quoted = new StringBuilder("\"");
        int backslashes = 0;
        foreach (char character in argument)
        {
            if (character == '\\')
            {
                backslashes++;
                continue;
            }
            if (character == '"')
            {
                quoted.Append('\\', backslashes * 2 + 1);
                quoted.Append('"');
                backslashes = 0;
                continue;
            }
            quoted.Append('\\', backslashes);
            backslashes = 0;
            quoted.Append(character);
        }
        quoted.Append('\\', backslashes * 2);
        quoted.Append('"');
        return quoted.ToString();
    }

    private static void CheckHandle(IntPtr handle)
    {
        if (handle == IntPtr.Zero || handle == new IntPtr(-1)) ThrowLastError();
    }

    private static void ThrowLastError()
    {
        throw new Win32Exception(Marshal.GetLastWin32Error());
    }
}
'@

try {
  $exitCode = [CoredotWindowsJobRunner]::Run(
    $Executable,
    [string[]]$CommandArguments
  )
  exit $exitCode
} catch {
  [Console]::Error.WriteLine("Managed Windows job failed")
  exit 125
}
