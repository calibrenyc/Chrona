# Render the installer sidebar from Chrona's existing logo and design tokens.
Add-Type -AssemblyName System.Drawing
$sidebar = New-Object System.Drawing.Bitmap 164,314
$graphics = [System.Drawing.Graphics]::FromImage($sidebar)
$graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$bounds = New-Object System.Drawing.Rectangle 0,0,164,314
$gradient = New-Object System.Drawing.Drawing2D.LinearGradientBrush $bounds,([System.Drawing.Color]::FromArgb(237,241,245)),([System.Drawing.Color]::FromArgb(188,215,239)),90
$graphics.FillRectangle($gradient,$bounds)
$logo = [System.Drawing.Image]::FromFile((Join-Path $PSScriptRoot '../build/icon.png'))
$graphics.DrawImage($logo,30,36,72,72)
$titleFont = New-Object System.Drawing.Font 'Segoe UI',22,([System.Drawing.FontStyle]::Bold)
$bodyFont = New-Object System.Drawing.Font 'Segoe UI',10
$ink = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(16,45,75))
$graphics.DrawString('Chrona',$titleFont,$ink,24,128)
$graphics.DrawString("Your library,`nin one place.",$bodyFont,$ink,26,170)
$graphics.FillRectangle([System.Drawing.Brushes]::DodgerBlue,26,269,42,4)
$sidebar.Save((Join-Path $PSScriptRoot '../build/installerSidebar.bmp'),[System.Drawing.Imaging.ImageFormat]::Bmp)
$logo.Dispose(); $graphics.Dispose(); $sidebar.Dispose(); $gradient.Dispose(); $titleFont.Dispose(); $bodyFont.Dispose(); $ink.Dispose()
