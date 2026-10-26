using System;
using System.IO;
using System.Text;

// A native process is intentional: a PowerShell function cannot exercise
// Windows argv parsing, redirected stderr, encodings or pipe backpressure.
public class FakeWsl
{
    static string Env(string key) { return Environment.GetEnvironmentVariable(key) ?? ""; }
    static string Json(string value)
    {
        return "\"" + value.Replace("\\", "\\\\").Replace("\"", "\\\"")
            .Replace("\r", "\\r").Replace("\n", "\\n").Replace("\t", "\\t") + "\"";
    }
    public static int Main(string[] args)
    {
        Console.OutputEncoding = new UTF8Encoding(false);
        Console.InputEncoding = new UTF8Encoding(false);
        string arguments = "[" + string.Join(",", Array.ConvertAll(args, Json)) + "]";
        File.AppendAllText(Env("BLAME_TEST_WSL_LOG"), arguments + "\n", new UTF8Encoding(false));
        if (args[0] == "--echo") { Console.Write(arguments); return 0; }
        if (args[0] == "--warning") { Console.Write("ok"); Console.Error.Write("warning"); return 0; }
        if (args[0] == "--fail") { Console.Write("partial"); Console.Error.Write("failed"); return 23; }
        if (args[0] == "--flood")
        {
            Console.Out.Write(new string('o', 262144));
            Console.Error.Write(new string('e', 262144));
            Console.Out.Write(Console.In.ReadToEnd());
            return 0;
        }
        if (args[0] == "--status") { Console.Error.Write("WSL warning"); return 0; }
        if (args[0] == "--list")
        {
            Console.Write("  NAME STATE VERSION\n* BlameRuntime Running 2\n");
            Console.Error.Write("list warning");
            return Env("BLAME_TEST_WSL_FAIL") == "list" ? 19 : 0;
        }
        if (args[0] == "--unregister") { Console.Error.Write("unregister failed"); return 17; }
        if (args.Length < 6 || args[4] != "--exec")
        { Console.Error.Write("Guest commands must bypass the default shell"); return 80; }
        if (args[5] == "wslpath")
        {
            Console.Write(Env("BLAME_TEST_WSL_PATH") + "\n");
            Console.Error.Write("translation warning");
            return Env("BLAME_TEST_WSL_FAIL") == "wslpath" ? 21 : 0;
        }
        if (args[5] == "cp") { return Env("BLAME_TEST_WSL_FAIL") == "cp" ? 22 : 0; }
        if (args[5] == "sh" && args.Length > 6 && args[6] == "-s")
        {
            string content = Console.In.ReadToEnd();
            File.WriteAllText(Env("BLAME_TEST_WSL_INPUT"), content, new UTF8Encoding(false));
            Console.Write(content);
            Console.Error.Write("script warning");
            return Env("BLAME_TEST_WSL_FAIL") == "provision" ? 24 : 0;
        }
        Console.Write(arguments);
        Console.Error.Write("command warning");
        return 29;
    }
}
