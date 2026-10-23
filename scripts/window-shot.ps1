# Waits for the next left click, captures the window under it, lets the person
# drag a range on the shot and puts that range on the clipboard. Prints OK,
# CANCEL (Escape) or TIMEOUT; each of the two waits has TimeoutSeconds.
param([int]$TimeoutSeconds = 30)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;

public static class WindowShot {
  [StructLayout(LayoutKind.Sequential)]
  public struct POINT { public int X; public int Y; }
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int key);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT point);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT point);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr window, uint flags);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr window, out RECT rect);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr window, int attribute, out RECT rect, int size);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr window, IntPtr after, int x, int y, int width, int height, uint flags);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr window);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr window);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, IntPtr processId);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint from, uint to, bool attach);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();

  // Puts the window over every other and gives it the keyboard. A background
  // process may not take the foreground on its own, so it borrows the input
  // of the thread that has it.
  public static void Raise(IntPtr window) {
    IntPtr topmost = new IntPtr(-1);
    uint noMoveNoSizeShow = 0x0001 | 0x0002 | 0x0040;
    SetWindowPos(window, topmost, 0, 0, 0, 0, noMoveNoSizeShow);
    uint own = GetCurrentThreadId();
    uint front = GetWindowThreadProcessId(GetForegroundWindow(), IntPtr.Zero);
    bool isAttached = front != 0 && front != own && AttachThreadInput(own, front, true);
    BringWindowToTop(window);
    SetForegroundWindow(window);
    if (isAttached) AttachThreadInput(own, front, false);
  }
}
'@

$VK_LBUTTON = 0x01
$VK_ESCAPE = 0x1B
$GA_ROOT = 2
$DWMWA_EXTENDED_FRAME_BOUNDS = 9

[void][WindowShot]::SetProcessDPIAware()
$isDown = { param($key) ([WindowShot]::GetAsyncKeyState($key) -band 0x8000) -ne 0 }
$deadline = (Get-Date).AddSeconds($TimeoutSeconds)

# The press that started this script is still down: wait for its release.
while (& $isDown $VK_LBUTTON) { Start-Sleep -Milliseconds 20 }

while (-not (& $isDown $VK_LBUTTON)) {
  if (& $isDown $VK_ESCAPE) { 'CANCEL'; exit 2 }
  if ((Get-Date) -gt $deadline) { 'TIMEOUT'; exit 3 }
  Start-Sleep -Milliseconds 15
}

$point = New-Object WindowShot+POINT
[void][WindowShot]::GetCursorPos([ref]$point)
$window = [WindowShot]::GetAncestor([WindowShot]::WindowFromPoint($point), $GA_ROOT)

# Let the click bring the window to the front before the screen is read.
while (& $isDown $VK_LBUTTON) { Start-Sleep -Milliseconds 20 }
Start-Sleep -Milliseconds 300

# The frame bounds leave out the invisible resize border GetWindowRect counts.
$rect = New-Object WindowShot+RECT
$size = [System.Runtime.InteropServices.Marshal]::SizeOf($rect)
if ([WindowShot]::DwmGetWindowAttribute($window, $DWMWA_EXTENDED_FRAME_BOUNDS, [ref]$rect, $size) -ne 0) {
  [void][WindowShot]::GetWindowRect($window, [ref]$rect)
}

$width = $rect.Right - $rect.Left
$height = $rect.Bottom - $rect.Top
if ($width -le 0 -or $height -le 0) { 'ERROR empty window'; exit 1 }

$bitmap = New-Object System.Drawing.Bitmap $width, $height
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.CopyFromScreen($rect.Left, $rect.Top, 0, 0, $bitmap.Size)
$graphics.Dispose()

# The shot is laid over its window, frozen, for the person to drag a range on:
# a drag takes that range, a plain click the whole window, Escape or the right
# button nothing.
$script:start = $null
$script:selection = [System.Drawing.Rectangle]::Empty
$script:outcome = 'CANCEL'
$rangeOf = {
  param($from, $to)
  $bounds = New-Object System.Drawing.Rectangle 0, 0, $width, $height
  $range = [System.Drawing.Rectangle]::FromLTRB(
    [Math]::Min($from.X, $to.X), [Math]::Min($from.Y, $to.Y),
    [Math]::Max($from.X, $to.X), [Math]::Max($from.Y, $to.Y))
  $range.Intersect($bounds)
  $range
}

$form = New-Object System.Windows.Forms.Form
$form.FormBorderStyle = 'None'
$form.StartPosition = 'Manual'
$form.AutoScaleMode = 'None'
$form.ShowInTaskbar = $false
$form.TopMost = $true
$form.KeyPreview = $true
$form.Bounds = New-Object System.Drawing.Rectangle $rect.Left, $rect.Top, $width, $height

$picture = New-Object System.Windows.Forms.PictureBox
$picture.Dock = 'Fill'
$picture.Image = $bitmap
$picture.Cursor = [System.Windows.Forms.Cursors]::Cross
$form.Controls.Add($picture)

$picture.Add_MouseDown({
  param($sender, $e)
  if ($e.Button -eq 'Right') { $form.Close(); return }
  $script:start = $e.Location
})
$picture.Add_MouseMove({
  param($sender, $e)
  if ($null -eq $script:start) { return }
  $script:selection = & $rangeOf $script:start $e.Location
  $picture.Invalidate()
})
$picture.Add_MouseUp({
  param($sender, $e)
  if ($null -eq $script:start) { return }
  $script:selection = & $rangeOf $script:start $e.Location
  $script:outcome = 'OK'
  $form.Close()
})
$picture.Add_Paint({
  param($sender, $e)
  $shade = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(90, 0, 0, 0))
  $pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(255, 0, 160, 255)), 2
  if ($script:selection.Width -gt 0 -and $script:selection.Height -gt 0) {
    # Everything but the range is dimmed.
    $outside = New-Object System.Drawing.Region (New-Object System.Drawing.Rectangle 0, 0, $width, $height)
    $outside.Exclude($script:selection)
    $e.Graphics.FillRegion($shade, $outside)
    $e.Graphics.DrawRectangle($pen, $script:selection)
    $outside.Dispose()
  } else {
    $e.Graphics.DrawRectangle($pen, 1, 1, $width - 2, $height - 2)
  }
  $shade.Dispose()
  $pen.Dispose()
})
$form.Add_KeyDown({
  param($sender, $e)
  if ($e.KeyCode -eq 'Escape') { $form.Close() }
})
$form.Add_Shown({ [WindowShot]::Raise($form.Handle) })

# The clicked window may come forward a moment after the overlay is up: the
# overlay is raised again a few times, until a drag has begun.
$script:raises = 0
$raiser = New-Object System.Windows.Forms.Timer
$raiser.Interval = 150
$raiser.Add_Tick({
  $script:raises += 1
  if ($script:raises -gt 6 -or $null -ne $script:start) { $raiser.Stop(); return }
  [WindowShot]::Raise($form.Handle)
})
$raiser.Start()

# An overlay nobody answers is taken down, not left over the window.
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = $TimeoutSeconds * 1000
$timer.Add_Tick({ $script:outcome = 'TIMEOUT'; $form.Close() })
$timer.Start()

[void]$form.ShowDialog()
$timer.Dispose()
$raiser.Dispose()
$form.Dispose()

if ($script:outcome -eq 'CANCEL') { $bitmap.Dispose(); 'CANCEL'; exit 2 }
if ($script:outcome -eq 'TIMEOUT') { $bitmap.Dispose(); 'TIMEOUT'; exit 3 }

# A press without a drag means the whole window.
$range = $script:selection
if ($range.Width -lt 5 -or $range.Height -lt 5) {
  $range = New-Object System.Drawing.Rectangle 0, 0, $width, $height
}

$shot = $bitmap.Clone($range, $bitmap.PixelFormat)
[System.Windows.Forms.Clipboard]::SetImage($shot)
$shot.Dispose()
$bitmap.Dispose()

"OK $($range.Width)x$($range.Height)"
