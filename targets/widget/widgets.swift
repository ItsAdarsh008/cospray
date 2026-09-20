import WidgetKit
import SwiftUI

// The app writes these keys into the shared App Group UserDefaults (see src/lib/widget.ts):
//   paintA, paintB (0-100), shake (0-100), colorA, colorB (hex), tag (string), updatedAt (unix seconds),
//   refillAtA, refillAtB (unix seconds when that can is full again), streak (days),
//   nameA, nameB (colour names), strokes, paintUsed (all-time stats)
let appGroup = "group.com.hamzakhan.tagged"

struct CanEntry: TimelineEntry {
  let date: Date
  let paintA: Double
  let paintB: Double
  let shake: Double
  let colorA: Color
  let colorB: Color
  let tag: String
  let refillAtA: Date
  let refillAtB: Date
  let streak: Int
  let nameA: String
  let nameB: String
  let colorAHex: String
  let colorBHex: String
  let strokes: Int
  let paintUsed: Int

  static func load() -> CanEntry {
    let d = UserDefaults(suiteName: appGroup)
    let a = d?.object(forKey: "paintA") as? Double ?? 100
    let b = d?.object(forKey: "paintB") as? Double ?? 100
    let s = d?.object(forKey: "shake") as? Double ?? 100
    return CanEntry(
      date: Date(), paintA: a, paintB: b, shake: s,
      colorA: Color(hex: d?.string(forKey: "colorA") ?? "#ff2d95"),
      colorB: Color(hex: d?.string(forKey: "colorB") ?? "#19e6ff"),
      tag: d?.string(forKey: "tag") ?? "FRESCO",
      refillAtA: Date(timeIntervalSince1970: d?.object(forKey: "refillAtA") as? Double ?? 0),
      refillAtB: Date(timeIntervalSince1970: d?.object(forKey: "refillAtB") as? Double ?? 0),
      streak: d?.object(forKey: "streak") as? Int ?? 0,
      nameA: d?.string(forKey: "nameA") ?? "Hot pink", nameB: d?.string(forKey: "nameB") ?? "Cyan",
      colorAHex: d?.string(forKey: "colorA") ?? "#ff2d95", colorBHex: d?.string(forKey: "colorB") ?? "#19e6ff",
      strokes: d?.object(forKey: "strokes") as? Int ?? 0, paintUsed: d?.object(forKey: "paintUsed") as? Int ?? 0)
  }
}

struct CanProvider: TimelineProvider {
  func placeholder(in context: Context) -> CanEntry { CanEntry.load() }
  func getSnapshot(in context: Context, completion: @escaping (CanEntry) -> Void) { completion(CanEntry.load()) }
  func getTimeline(in context: Context, completion: @escaping (Timeline<CanEntry>) -> Void) {
    // Paint regenerates ~2.2/s in the app; the app pushes fresh values whenever they change, and we
    // also refresh every 15 minutes so a closed app still shows a filling can.
    let entry = CanEntry.load()
    let next = Calendar.current.date(byAdding: .minute, value: 15, to: Date())!
    completion(Timeline(entries: [entry], policy: .after(next)))
  }
}

struct CanBar: View {
  let value: Double
  let color: Color
  let label: String
  var body: some View {
    VStack(spacing: 4) {
      GeometryReader { g in
        ZStack(alignment: .bottom) {
          RoundedRectangle(cornerRadius: 8).fill(Color.white.opacity(0.12))
          RoundedRectangle(cornerRadius: 8).fill(color).frame(height: max(4, g.size.height * value / 100))
        }
      }
      Text(label).font(.system(size: 9, weight: .heavy)).foregroundStyle(.white)
      Text("\(Int(value))%").font(.system(size: 9)).foregroundStyle(.white.opacity(0.7))
    }
  }
}

struct Gauge: View {
  let value: Double
  let color: Color
  let label: String
  let refillAt: Date
  var body: some View {
    VStack(alignment: .leading, spacing: 3) {
      HStack {
        Text(label).font(.system(size: 9, weight: .heavy)).foregroundStyle(.white)
        Spacer()
        if value >= 99.5 || refillAt <= Date() {
          Text("full").font(.system(size: 9, weight: .semibold)).foregroundStyle(.white.opacity(0.7))
        } else {
          (Text("full in ") + Text(refillAt, style: .timer)).font(.system(size: 9, weight: .semibold)).foregroundStyle(.white.opacity(0.7)).monospacedDigit()
        }
      }
      GeometryReader { g in
        ZStack(alignment: .leading) {
          RoundedRectangle(cornerRadius: 5).fill(Color.white.opacity(0.12))
          RoundedRectangle(cornerRadius: 5).fill(color).frame(width: max(4, g.size.width * value / 100))
        }
      }.frame(height: 9)
    }
  }
}

/// Equipped colour: a ring swatch with the colour name. What the user sees first on the home screen.
struct Swatch: View {
  let color: Color
  let label: String
  let name: String
  var size: CGFloat = 26
  var body: some View {
    HStack(spacing: 6) {
      Circle().fill(color).frame(width: size, height: size)
        .overlay(Circle().stroke(.white.opacity(0.9), lineWidth: 2))
        .shadow(color: color.opacity(0.7), radius: 4)
      VStack(alignment: .leading, spacing: 0) {
        Text(label).font(.system(size: 9, weight: .heavy)).foregroundStyle(.white)
        Text(name).font(.system(size: 8, weight: .semibold)).foregroundStyle(.white.opacity(0.65))
      }
    }
  }
}

struct PaintCanView: View {
  var entry: CanEntry
  @Environment(\.widgetFamily) var family

  var status: String {
    entry.shake < 12 ? "shake the can" : (min(entry.paintA, entry.paintB) < 18 ? "running low…" : "ready to spray")
  }

  var body: some View {
    Group {
      switch family {
      case .systemMedium: medium
      case .accessoryRectangular: lockRect
      case .accessoryCircular: lockCircle
      case .accessoryInline: Text("🎨 \(Int(entry.paintA))% · \(Int(entry.paintB))% · 🔥\(entry.streak)")
      default: small
      }
    }
    .containerBackground(for: .widget) { Color(hex: "#0b0b0f") }
  }

  var small: some View {
    VStack(alignment: .leading, spacing: 6) {
      HStack {
        Text("FRESCO").font(.system(size: 10, weight: .black)).tracking(2).foregroundStyle(.white)
        Spacer()
        Text("🔥\(entry.streak)").font(.system(size: 10, weight: .bold)).foregroundStyle(.white.opacity(0.8))
      }
      HStack(spacing: 8) {
        Swatch(color: entry.colorA, label: "A", name: entry.nameA, size: 22)
        Swatch(color: entry.colorB, label: "B", name: entry.nameB, size: 22)
      }
      HStack(spacing: 8) {
        CanBar(value: entry.paintA, color: entry.colorA, label: "A")
        CanBar(value: entry.paintB, color: entry.colorB, label: "B")
        CanBar(value: entry.shake, color: entry.shake < 12 ? Color(hex: "#ff5c1a") : Color(hex: "#7cff3a"), label: "CAN")
      }
      Text(status).font(.system(size: 9, weight: .semibold)).foregroundStyle(.white.opacity(0.8)).lineLimit(1)
    }
  }

  var medium: some View {
    HStack(spacing: 14) {
      VStack(alignment: .leading, spacing: 8) {
        HStack {
          Text("FRESCO").font(.system(size: 11, weight: .black)).tracking(2).foregroundStyle(.white)
          Spacer()
          Text(entry.tag).font(.system(size: 10, weight: .bold)).foregroundStyle(.white.opacity(0.7)).lineLimit(1)
        }
        HStack(spacing: 14) {
          Swatch(color: entry.colorA, label: "VOL+ · A", name: entry.nameA)
          Swatch(color: entry.colorB, label: "VOL− · B", name: entry.nameB)
        }
        Gauge(value: entry.paintA, color: entry.colorA, label: "A", refillAt: entry.refillAtA)
        Gauge(value: entry.paintB, color: entry.colorB, label: "B", refillAt: entry.refillAtB)
        Text("\(status) · \(entry.strokes) strokes · \(entry.paintUsed) paint all-time").font(.system(size: 9, weight: .semibold)).foregroundStyle(.white.opacity(0.8)).lineLimit(1)
      }
      VStack(spacing: 4) {
        Text("🔥").font(.system(size: 20))
        Text("\(entry.streak)").font(.system(size: 24, weight: .black)).foregroundStyle(.white)
        Text("day streak").font(.system(size: 8, weight: .bold)).foregroundStyle(.white.opacity(0.7))
        CanBar(value: entry.shake, color: entry.shake < 12 ? Color(hex: "#ff5c1a") : Color(hex: "#7cff3a"), label: "CAN").frame(width: 30)
      }
      .frame(width: 66)
      .padding(6)
      .background(RoundedRectangle(cornerRadius: 14).fill(Color.white.opacity(0.08)))
    }
  }

  /// Lock screen, rectangular: both colours + levels + streak (monochrome-safe: colours also carry a label).
  var lockRect: some View {
    VStack(alignment: .leading, spacing: 2) {
      HStack(spacing: 4) {
        Text("FRESCO").font(.system(size: 10, weight: .black)).tracking(1)
        Spacer()
        Text("🔥\(entry.streak)").font(.system(size: 10, weight: .bold))
      }
      HStack(spacing: 6) {
        Circle().fill(entry.colorA).frame(width: 10, height: 10).overlay(Circle().stroke(.white, lineWidth: 1))
        Text("\(Int(entry.paintA))%").font(.system(size: 10, weight: .semibold))
        Circle().fill(entry.colorB).frame(width: 10, height: 10).overlay(Circle().stroke(.white, lineWidth: 1))
        Text("\(Int(entry.paintB))%").font(.system(size: 10, weight: .semibold))
      }
      Text(status).font(.system(size: 9)).opacity(0.8)
    }
  }

  var lockCircle: some View {
    ZStack {
      AccessoryWidgetBackground()
      Circle().trim(from: 0, to: entry.paintA / 100).stroke(entry.colorA, style: StrokeStyle(lineWidth: 4, lineCap: .round)).rotationEffect(.degrees(-90)).padding(3)
      Circle().trim(from: 0, to: entry.paintB / 100).stroke(entry.colorB, style: StrokeStyle(lineWidth: 4, lineCap: .round)).rotationEffect(.degrees(-90)).padding(9)
      Text("\(Int(min(entry.paintA, entry.paintB)))").font(.system(size: 13, weight: .black))
    }
  }
}

struct PaintCanWidget: Widget {
  let kind = "widget"
  var body: some WidgetConfiguration {
    StaticConfiguration(kind: kind, provider: CanProvider()) { entry in PaintCanView(entry: entry) }
      .configurationDisplayName("Fresco can")
      .description("Your equipped colours, paint left, refill countdown and streak.")
      .supportedFamilies([.systemSmall, .systemMedium, .accessoryRectangular, .accessoryCircular, .accessoryInline])
  }
}

extension Color {
  init(hex: String) {
    var s = hex.trimmingCharacters(in: .whitespacesAndNewlines)
    if s.hasPrefix("#") { s.removeFirst() }
    var n: UInt64 = 0
    Scanner(string: s).scanHexInt64(&n)
    let r = Double((n >> 16) & 0xff) / 255, g = Double((n >> 8) & 0xff) / 255, b = Double(n & 0xff) / 255
    self.init(red: r, green: g, blue: b)
  }
}
