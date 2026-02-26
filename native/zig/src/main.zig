const std = @import("std");

fn isAbsPath(path: []const u8) bool {
    return std.fs.path.isAbsolute(path);
}

fn pathSize(path: []const u8) !u64 {
    const cwd = std.fs.cwd();
    const file_res = if (isAbsPath(path)) std.fs.openFileAbsolute(path, .{}) else cwd.openFile(path, .{});
    if (file_res) |file| {
        defer file.close();
        const st = try file.stat();
        if (st.kind != .directory) {
            return st.size;
        }
    } else |err| {
        if (err != error.IsDir) {
            return err;
        }
    }

    var dir = if (isAbsPath(path))
        try std.fs.openDirAbsolute(path, .{ .iterate = true, .access_sub_paths = true })
    else
        try cwd.openDir(path, .{ .iterate = true, .access_sub_paths = true });
    defer dir.close();

    return dirTreeSize(&dir);
}

fn dirTreeSize(dir: *std.fs.Dir) !u64 {
    var total: u64 = 0;
    var it = dir.iterate();

    while (try it.next()) |entry| {
        switch (entry.kind) {
            .file => {
                const st = dir.statFile(entry.name) catch continue;
                total += st.size;
            },
            .directory => {
                var sub = dir.openDir(entry.name, .{ .iterate = true, .access_sub_paths = true }) catch continue;
                defer sub.close();
                total += dirTreeSize(&sub) catch 0;
            },
            .sym_link => {},
            else => {
                const st = dir.statFile(entry.name) catch continue;
                if (st.kind == .file) {
                    total += st.size;
                }
            },
        }
    }

    return total;
}

fn printPing(writer: *std.Io.Writer) !void {
    try writer.writeAll("{\"ok\":true,\"engine\":\"zig\",\"version\":\"1.1.0\"}\n");
}

fn runDu(args: []const []const u8, writer: *std.Io.Writer) !void {
    for (args) |p| {
        const size = pathSize(p) catch 0;
        try writer.print("{d}\t{s}\n", .{ size, p });
    }
}

pub fn main() !void {
    var gpa = std.heap.GeneralPurposeAllocator(.{}){};
    defer _ = gpa.deinit();
    const allocator = gpa.allocator();

    const args = try std.process.argsAlloc(allocator);
    defer std.process.argsFree(allocator, args);

    var stdout_buffer: [8192]u8 = undefined;
    var stdout_writer = std.fs.File.stdout().writer(&stdout_buffer);
    const writer = &stdout_writer.interface;

    if (args.len >= 2 and std.mem.eql(u8, args[1], "--ping")) {
        try printPing(writer);
        try writer.flush();
        return;
    }

    if (args.len >= 2 and std.mem.eql(u8, args[1], "du")) {
        if (args.len == 2) return;
        try runDu(args[2..], writer);
        try writer.flush();
        return;
    }

    try writer.writeAll("Usage: wecom-cleaner-core --ping | du <path...>\n");
    try writer.flush();
}
