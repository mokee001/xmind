Pod::Spec.new do |spec|
  spec.name = 'PetCutout'
  spec.version = '1.0.0'
  spec.summary = 'On-device pet foreground cutout for Photo Wall.'
  spec.description = 'Uses Apple Vision to create transparent PNG cutouts on iPhone.'
  spec.license = { :type => 'MIT' }
  spec.author = 'Photo Wall'
  spec.homepage = 'https://mokeedesign.cn'
  spec.platforms = { :ios => '17.0' }
  spec.swift_version = '6.0'
  spec.source = { :git => '' }
  spec.static_framework = true

  spec.dependency 'ExpoModulesCore'
  spec.source_files = '**/*.swift'
end