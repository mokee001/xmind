import Foundation
import EchooCore

/// User approved the final v5 layout and replacing v1.0.0 on 2026-10-16. This concerns
/// template styling/layout, not unseen photographs or end-to-end automation.
public enum BlueSkyTemplateRelease {
    public static let version = "1.0.0"
    public static let visualApprovalDate = "2026-10-16"
    public static let approvalStatement = "好的，就以最终这版作为蓝天绿地模板的规范进行存档吧，覆盖v1.0.0"
    public static var outlineParametersApproved: Bool {
        BlueSkyOutlineStyle.version == "blue-sky-outline-v3"
    }
    public static var visualApproved: Bool {
        BlueSkyLayout.version == "park-5-4-layout-v5" && outlineParametersApproved
    }
}
