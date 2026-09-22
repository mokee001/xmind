#pragma once
#ifdef PHOTOWALL_RETERMINAL_E1002
#include "panel_e1002.h"
namespace photowall { using DisplayPanel = PanelE1002; }
#else
#include "panel_13in3e6.h"
namespace photowall { using DisplayPanel = Panel13in3E6; }
#endif
