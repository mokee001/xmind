Pod::Spec.new do |spec|
  spec.name = 'LocalPhotoCuration'
  spec.version = '1.0.0'
  spec.summary = 'Privacy-first on-device photo preselection for Photo Wall.'
  spec.description = 'Uses PhotoKit, Vision and Core Image without uploading the photo library.'
  spec.license = { :type => 'MIT' }
  spec.author = 'Photo Wall'
  spec.homepage = 'https://mokeedesign.cn'
  spec.platforms = { :ios => '17.0' }
  spec.swift_version = '6.0'
  spec.source = { :git => '' }
  spec.static_framework = true

  spec.frameworks = 'Photos', 'Vision', 'CoreImage'
  spec.dependency 'ExpoModulesCore'
  spec.source_files = '**/*.swift'
end
