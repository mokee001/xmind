#include "frame_format.h"
#include <array>
#include <cassert>
#include <vector>
#include <iostream>
using namespace photowall;
std::array<uint8_t,45> header(uint16_t w, uint16_t h) {
  std::array<uint8_t,45> a{};
  memcpy(a.data(), "PWE6", 4); a[4]=1;
  a[5]=w>>8; a[6]=w; a[7]=h>>8; a[8]=h;
  uint32_t n=uint32_t(w)*h/2;
  a[9]=n>>24; a[10]=n>>16; a[11]=n>>8; a[12]=n;
  return a;
}
int main() {
  FrameShape shape;
  auto legacy=header(1200,1600), native=header(800,480);
  assert(parseFrameHeader(legacy.data(),45,shape) && shape.bytes==960000);
#ifdef PHOTOWALL_RETERMINAL_E1002
  assert(parseFrameHeader(native.data(),45,shape) && shape.bytes==192000);
#else
  assert(!parseFrameHeader(native.data(),45,shape));
#endif
  assert(!parseFrameHeader(nullptr,45,shape));
  for (int n=0;n<45;n++) assert(!parseFrameHeader(legacy.data(),n,shape));
  auto bad=header(480,800); assert(!parseFrameHeader(bad.data(),45,shape));
  bad=legacy; bad[12]^=1; assert(!parseFrameHeader(bad.data(),45,shape));
  bad=legacy; bad[9]=255; assert(!parseFrameHeader(bad.data(),45,shape));
  bad=legacy; bad[4]=2; assert(!parseFrameHeader(bad.data(),45,shape));
  bad=legacy; bad[0]=0; assert(!parseFrameHeader(bad.data(),45,shape));
  for (int value=0;value<256;value++) {
    uint8_t byte=value;
    auto valid=[](int c) { return c==0||c==1||c==2||c==3||c==5||c==6; };
    assert(validPanelCodes(&byte,1)==(valid(value&15)&&valid(value>>4)));
  }
  std::vector<uint8_t> pixels(192000,0x63);
  // Native orientation and both nibbles must survive at all four corners.
  for (int y : {0,479}) {
    assert(containedPixel(pixels.data(),800,480,0,y,800,480)==3);
    assert(containedPixel(pixels.data(),800,480,1,y,800,480)==6);
    assert(containedPixel(pixels.data(),800,480,798,y,800,480)==3);
    assert(containedPixel(pixels.data(),800,480,799,y,800,480)==6);
  }
  std::vector<uint8_t> portrait(960000,0x00);
  // Portrait 1200x1600 fits in 360x480, with 220px white margins.
  for (int y=0;y<480;y++) for(int x=0;x<800;x++)
    assert(containedPixel(portrait.data(),1200,1600,x,y,800,480)==
           (x<220||x>=580 ? 1 : 0));
  std::cout << "PWE6 validation, palette, nibble order and full-frame bounds passed\n";
}
