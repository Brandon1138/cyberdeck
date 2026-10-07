import SwiftUI

struct ResourceFixture {
    static func normalize(_ value: String) -> String {
        value.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    }
}

@main
struct NativeResourceApp: App {
    var body: some Scene {
        WindowGroup { Text(ResourceFixture.normalize(" Resource Managed ")) }
    }
}
