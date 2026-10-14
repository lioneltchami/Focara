// Draws the Odak app icon (our own artwork): a screen card with a focus ring and cursor.
import AppKit
let s = 1024.0
let img = NSImage(size: NSSize(width: s, height: s))
img.lockFocus()
let ctx = NSGraphicsContext.current!.cgContext
let body = CGPath(roundedRect: CGRect(x: 100, y: 100, width: 824, height: 824), cornerWidth: 185, cornerHeight: 185, transform: nil)
ctx.saveGState(); ctx.addPath(body); ctx.clip()
let g = CGGradient(colorsSpace: CGColorSpace(name: CGColorSpace.sRGB), colors: [
    CGColor(srgbRed: 0.09, green: 0.36, blue: 0.40, alpha: 1), CGColor(srgbRed: 0.30, green: 0.27, blue: 0.75, alpha: 1)] as CFArray, locations: [0, 1])!
ctx.drawLinearGradient(g, start: CGPoint(x: 100, y: 924), end: CGPoint(x: 924, y: 100), options: [])
ctx.restoreGState()
ctx.setFillColor(CGColor(gray: 0.97, alpha: 1))
ctx.addPath(CGPath(roundedRect: CGRect(x: 230, y: 330, width: 564, height: 360), cornerWidth: 34, cornerHeight: 34, transform: nil)); ctx.fillPath()
ctx.setStrokeColor(CGColor(srgbRed: 0.18, green: 0.80, blue: 0.70, alpha: 1)); ctx.setLineWidth(28)
ctx.strokeEllipse(in: CGRect(x: 430, y: 420, width: 180, height: 180))
ctx.setFillColor(CGColor(srgbRed: 0.18, green: 0.80, blue: 0.70, alpha: 1))
ctx.fillEllipse(in: CGRect(x: 500, y: 490, width: 40, height: 40))
let c = CGMutablePath()
c.move(to: CGPoint(x: 600, y: 470)); c.addLine(to: CGPoint(x: 600, y: 380)); c.addLine(to: CGPoint(x: 623, y: 400))
c.addLine(to: CGPoint(x: 638, y: 368)); c.addLine(to: CGPoint(x: 652, y: 375)); c.addLine(to: CGPoint(x: 637, y: 406))
c.addLine(to: CGPoint(x: 667, y: 406)); c.closeSubpath()
ctx.addPath(c); ctx.setFillColor(CGColor(gray: 0.1, alpha: 1)); ctx.fillPath()
img.unlockFocus()
let rep = NSBitmapImageRep(data: img.tiffRepresentation!)!
let small = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 1024, pixelsHigh: 1024, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
NSGraphicsContext.saveGraphicsState(); NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: small)
rep.draw(in: NSRect(x: 0, y: 0, width: 1024, height: 1024)); NSGraphicsContext.restoreGraphicsState()
try! small.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: CommandLine.arguments[1]))
