Pod::Spec.new do |s|
  s.name           = 'ScrayAudio'
  s.version        = '1.0.0'
  s.summary        = 'BBW Sounds: the web view, saving to the phone, and local file serving'
  s.description    = 'The native half of the Scray audio app.'
  s.author         = ''
  s.homepage       = 'https://docs.expo.dev/modules/'
  s.platforms      = {
    :ios => '16.4'
  }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }

  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"
end
