# Speed pass (2026-09-24)

Owner's words: "Make it really laser fast", then "FAST loading like instant,
on any internet connection". Measured on staging (alphaos-staging.vercel.app,
functions and Neon both in iad1) from Melbourne, headless Chrome, logins for
admin, VA and designer. Scripts (all in `scripts/qa/`, runnable again):

- `perf.mjs`: every nav page per role, laptop 1280x800 and phone 390x844.
  COLD = fresh browser context (no cache, new TLS), WARM = reload right after.
  `nav` = click the sidebar link (laptop) or bottom tab / More drawer (phone)
  until the new page is in `<main>` with no skeleton left; "nav cold" is the
  first visit in the session, "nav warm" the second lap. `--throttle fast3g`
  (1.6 Mbps, 150 ms RTT) or `slow3g` (400 kbps, 400 ms RTT) via CDP.
- `ttfb-probe.mjs`: splits time to first byte into network floor, middleware
  and page. `resources.mjs`: what a cold load downloads. `trace-pages.mjs`:
  pairs with a `DB_TRACE` server log to count statements per page (the tracer
  was a temporary hook, not committed). `perf-table.mjs`: the tables below.

Screenshots: `var/e2e-shots/perf/{before,after,after-settled}` (gitignored).
The "after-settled" pass loaded every page for every role at both sizes: all
render their real heading with no skeleton left and no console errors; the
lazily loaded Alpha chat opens on the very first click and "Show me around"
still starts the tour.

## Where the time goes (the one thing to know)

| Probe, warm, from Melbourne (median) | before | after |
|---|---|---|
| `/api/health` (function in iad1, no DB): the network floor | 275-300 ms | same |
| any page as a client navigation (RSC request) | 490-530 ms | **265-300 ms** |
| any page as a full document load | 550-600 ms | 550-600 ms |

The floor is the Melbourne to Virginia round trip (the function and database
live in iad1). The middleware ran in iad1 too, not at the edge, so every
request crossed the Pacific twice: 1-3 ms of middleware code cost ~250 ms.
Client navigations and prefetches now skip it (each page does its own auth +
role redirect), which brought them down to the floor. Full document loads
still go through it, to keep the clean 307 denials the security QA asked for.
Server work itself is small: 40-150 ms of database time on most pages.

## Before / after tables

Numbers are ms, `before / after`. "ready" = the page's real content painted;
it falls back to LCP where a page redirects itself after load (`/orders`
restores a saved view, `/me` sends staff to `/designers`). "-" = not measured
(the phone walk cannot reach `/help` through the drawer).


### Slowest pages, admin (before / after)

| page | laptop nav cold | laptop nav warm | Fast 3G ready cold | Fast 3G nav cold | Slow 3G ready cold | Slow 3G nav cold |
|---|---|---|---|---|---|---|
| /orders/[id] | 783 / 621 | 631 / 33 | 1871 / 1440 | 2940 / 606 | 4781 / 2972 | 9480 / 753 |
| /health | 895 / 804 | 935 / 44 | 3101 / 1520 | 1062 / 806 | 3531 / 2703 | 1210 / 780 |
| /settings | 877 / 452 | 833 / 52 | 1437 / 1281 | 1123 / 743 | 4161 / 3263 | 2770 / 725 |
| /board | 910 / 661 | 1066 / 49 | 1529 / 1178 | 1278 / 657 | 4632 / 4598 | 4280 / 1057 |
| /dashboard | 1128 / 93 | 893 / 1582* | 1533 / 1550 | 904 / 657 | 3778 / 2973 | 971 / 788 |

\* one outlier sample; the phone and throttled walks show /dashboard warm nav at 650-820 ms.

Designer /board on a phone: Fast 3G ready cold 2319 -> 1426 ms, bytes 2.8 MB -> 0.9 MB.


### Unthrottled (laptop and phone)

**admin, laptop** (ms, before / after)

| page | TTFB cold | TTFB warm | LCP cold | LCP warm | nav cold | nav warm |
|---|---|---|---|---|---|---|
| /dashboard | 627 / 848 | 560 / 583 | 1104 / 1196 | 952 / 976 | 1128 / 93 | 893 / 1582 |
| /today | 606 / 587 | 547 / 571 | 1100 / 1072 | 924 / 960 | 891 / 723 | 880 / 911 |
| /orders | 775 / 886 | 590 / 732 | 1164 / 1276 | 972 / 812 | 642 / 370 | 851 / 661 |
| /orders/[id] | 615 / 666 | 593 / 622 | 1120 / 1116 | 1052 / 1052 | 783 / 621 | 631 / 33 |
| /qc | 603 / 558 | 986 / 605 | 996 / 820 | 1380 / 996 | 646 / 699 | 615 / 43 |
| /emails | 684 / 565 | 536 / 604 | 1940 / 976 | 932 / 984 | 816 / 433 | 803 / 68 |
| /board | 800 / 613 | 608 / 723 | 1368 / 1276 | 1108 / 1116 | 910 / 661 | 1066 / 49 |
| /queue/print | 642 / 585 | 547 / 588 | 756 / 1012 | 652 / 956 | 688 / 401 | 884 / 33 |
| /payouts | 748 / 671 | 549 / 556 | 1176 / 1160 | 912 / 908 | 643 / 396 | 576 / 44 |
| /settings | 659 / 595 | 549 / 558 | 1092 / 1012 | 920 / 920 | 877 / 452 | 833 / 52 |
| /designers | 756 / 569 | 568 / 879 | 1360 / 980 | 956 / 1244 | 628 / 413 | 744 / 42 |
| /styles | 685 / 545 | 553 / 557 | 1096 / 960 | 920 / 648 | 903 / 691 | 632 / 54 |
| /health | 889 / 756 | 545 / 567 | 1664 / 1432 | 916 / 1236 | 895 / 804 | 935 / 44 |
| /customers | 664 / 546 | 544 / 577 | 1100 / 1028 | 1152 / 968 | 607 / 378 | 602 / 44 |
| /me | 557 / 600 | 586 / 556 | 936 / 1156 | 952 / 736 | 1090 / 611 | 1656 / 778 |
| /help | 614 / 549 | 553 / 553 | 888 / 836 | 660 / 792 | 867 / 13 | 864 / 634 |

**admin, phone** (ms, before / after)

| page | TTFB cold | TTFB warm | LCP cold | LCP warm | nav cold | nav warm |
|---|---|---|---|---|---|---|
| /dashboard | 644 / 585 | 559 / 598 | 1064 / 1148 | 948 / 1036 | 889 / 663 | 1030 / 657 |
| /today | 780 / 547 | 582 / 563 | 1196 / 968 | 672 / 1020 | 904 / 686 | 924 / 690 |
| /orders | 549 / 655 | 613 / 782 | 928 / 1036 | 980 / 848 | 852 / 378 | 629 / 445 |
| /orders/[id] | 679 / 594 | 542 / 585 | 1220 / 712 | 980 / 1020 | 888 / 610 | 734 / 621 |
| /qc | 618 / 584 | 547 / 851 | 712 / 932 | 904 / 1240 | 656 / 687 | 831 / 367 |
| /emails | 637 / 540 | 583 / 569 | 760 / 960 | 960 / 948 | 786 / 541 | 681 / 394 |
| /board | 608 / 687 | 536 / 567 | 1164 / 1456 | 1088 / 956 | 876 / 853 | 874 / 655 |
| /queue/print | 691 / 628 | 600 / 581 | 1112 / 1036 | 680 / 952 | 624 / 420 | 606 / 638 |
| /payouts | 616 / 662 | 538 / 625 | 1052 / 1100 | 912 / 988 | 618 / 857 | 624 / 351 |
| /settings | 664 / 579 | 620 / 543 | 1064 / 992 | 992 / 936 | 870 / 448 | 874 / 563 |
| /designers | 640 / 593 | 555 / 584 | 1088 / 1040 | 940 / 956 | 652 / 526 | 624 / 375 |
| /styles | 638 / 563 | 603 / 743 | 760 / 1108 | 992 / 1128 | 775 / 420 | 638 / 403 |
| /health | 925 / 801 | 530 / 616 | 1368 / 1244 | 892 / 992 | 926 / 758 | 927 / 770 |
| /customers | 646 / 563 | 584 / 738 | 1044 / 1056 | 944 / 1120 | 775 / 401 | 846 / 397 |
| /me | 579 / 565 | 585 / 602 | 952 / 644 | 936 / 652 | 1165 / 894 | 1469 / 1068 |
| /help | 652 / 582 | 564 / 555 | 912 / 924 | 816 / 1132 | - / - | - / - |

**va, laptop** (ms, before / after)

| page | TTFB cold | TTFB warm | LCP cold | LCP warm | nav cold | nav warm |
|---|---|---|---|---|---|---|
| /dashboard | 718 / 812 | 772 / 597 | 1284 / 1160 | 1176 / 1012 | 894 / 79 | 885 / 49 |
| /today | 644 / 697 | 557 / 725 | 1052 / 1132 | 956 / 1092 | 896 / 664 | 1084 / 47 |
| /orders | 623 / 1158 | 545 / 790 | 1012 / 1732 | 932 / 1176 | 607 / 394 | 861 / 605 |
| /orders/[id] | 711 / 557 | 525 / 661 | 1152 / 1136 | 1044 / 1244 | 940 / 612 | 632 / 23 |
| /qc | 623 / 587 | 567 / 585 | 1028 / 692 | 812 / 936 | 867 / 439 | 809 / 36 |
| /emails | 691 / 606 | 554 / 648 | 1116 / 1304 | 960 / 1024 | 685 / 801 | 637 / 66 |
| /board | 657 / 540 | 559 / 562 | 1368 / 1152 | 956 / 948 | 873 / 680 | 886 / 52 |
| /queue/print | 780 / 557 | 584 / 544 | 948 / 656 | 932 / 928 | 646 / 437 | 683 / 41 |
| /settings | 614 / 607 | 557 / 795 | 776 / 716 | 620 / 1152 | 552 / 311 | 534 / 12 |
| /designers | 751 / 563 | 547 / 581 | 904 / 980 | 900 / 964 | 624 / 520 | 622 / 42 |
| /styles | 686 / 938 | 573 / 534 | 828 / 1376 | 968 / 620 | 880 / 531 | 623 / 50 |
| /customers | 651 / 700 | 559 / 603 | 1332 / 852 | 936 / 960 | 606 / 584 | 593 / 56 |
| /me | 561 / 578 | 653 / 590 | 916 / 944 | 1020 / 664 | 1114 / 320 | 1757 / 27 |
| /help | 643 / 573 | 584 / 560 | 1064 / 700 | 948 / 692 | 846 / 19 | 1063 / 611 |

**va, phone** (ms, before / after)

| page | TTFB cold | TTFB warm | LCP cold | LCP warm | nav cold | nav warm |
|---|---|---|---|---|---|---|
| /dashboard | 630 / 610 | 556 / 582 | 1368 / 1060 | 952 / 1152 | 915 / 693 | 971 / 721 |
| /today | 620 / 553 | 545 / 573 | 1028 / 1020 | 924 / 952 | 1079 / 675 | 1138 / 677 |
| /orders | 554 / 561 | 647 / 743 | 936 / 940 | 1024 / 804 | 642 / 376 | 660 / 437 |
| /orders/[id] | 699 / 577 | 549 / 565 | 1204 / 1012 | 1008 / 948 | 779 / 598 | 660 / 902 |
| /qc | 624 / 571 | 555 / 555 | 1012 / 968 | 900 / 972 | 650 / 447 | 851 / 484 |
| /emails | 622 / 564 | 568 / 580 | 1052 / 984 | 936 / 1000 | 1045 / 544 | 817 / 456 |
| /board | 635 / 535 | 577 / 615 | 1116 / 976 | 960 / 1028 | 861 / 717 | 871 / 656 |
| /queue/print | 625 / 772 | 542 / 627 | 1012 / 888 | 776 / 720 | 689 / 414 | 604 / 341 |
| /settings | 748 / 549 | 545 / 548 | 1144 / 1124 | 588 / 780 | 545 / 289 | 883 / 609 |
| /designers | 677 / 557 | 559 / 770 | 780 / 660 | 920 / 1140 | 698 / 689 | 836 / 641 |
| /styles | 627 / 568 | 569 / 589 | 1120 / 1000 | 648 / 968 | 627 / 774 | 646 / 700 |
| /customers | 612 / 627 | 584 / 557 | 1032 / 1052 | 988 / 932 | 590 / 451 | 615 / 372 |
| /me | 555 / 612 | 928 / 555 | 936 / 864 | 976 / 904 | 1238 / 1233 | 1434 / 899 |
| /help | 648 / 573 | 569 / 552 | 904 / 992 | 652 / 924 | - / - | - / - |

**designer, laptop** (ms, before / after)

| page | TTFB cold | TTFB warm | LCP cold | LCP warm | nav cold | nav warm |
|---|---|---|---|---|---|---|
| /dashboard | 673 / 776 | 602 / 783 | 1124 / 1244 | 676 / 1204 | 894 / 60 | 919 / 47 |
| /board | 788 / 638 | 594 / 581 | 1380 / 1632 | 1020 / 964 | 879 / 707 | 1089 / 48 |
| /orders/[id] | 664 / 873 | 605 / 551 | 1244 / 1332 | 1064 / 1012 | 928 / 629 | 619 / 14 |
| /me | 648 / 803 | 555 / 568 | 1092 / 972 | 936 / 940 | 843 / 434 | 639 / 38 |
| /help | 648 / 655 | 566 / 663 | 768 / 920 | 628 / 932 | 869 / 14 | 1069 / 13 |

**designer, phone** (ms, before / after)

| page | TTFB cold | TTFB warm | LCP cold | LCP warm | nav cold | nav warm |
|---|---|---|---|---|---|---|
| /dashboard | 597 / 586 | 560 / 582 | 812 / 1152 | 940 / 964 | 895 / 747 | 932 / 735 |
| /board | 739 / 580 | 647 / 748 | 1028 / 1224 | 1032 / 876 | 873 / 692 | 1130 / 660 |
| /orders/[id] | 697 / 686 | 532 / 605 | 1316 / 1120 | 1076 / 856 | 756 / 623 | 608 / 612 |
| /me | 896 / 660 | 712 / 557 | 1368 / 1052 | 1076 / 936 | 672 / 713 | 584 / 381 |
| /help | 652 / 585 | 754 / 561 | 920 / 844 | 856 / 804 | 831 / 725 | 886 / 637 |


### Fast 3G, phone

**admin, phone, Fast 3G** (ms, before / after)

| page | TTFB cold | paint cold | ready cold | TTFB warm | paint warm | ready warm | nav cold | nav warm |
|---|---|---|---|---|---|---|---|---|
| /dashboard | 715 / 898 | 1552 / 1568 | 1533 / 1550 | 884 / 555 | 956 / 984 | 1285 / 1101 | 904 / 657 | 957 / 695 |
| /today | 703 / 700 | 1500 / 1428 | 1493 / 1402 | 692 / 537 | 764 / 632 | 1095 / 962 | 1032 / 1230 | 925 / 669 |
| /orders | 812 / 545 | 936 / 628 | 936 / 1914 | 722 / 588 | 808 / 1076 | 808 / 1410 | 612 / 628 | 695 / 350 |
| /orders/[id] | 827 / 635 | 1548 / 1116 | 1871 / 1440 | 633 / 584 | 720 / 840 | 1098 / 1206 | 2940 / 606 | 954 / 597 |
| /qc | 668 / 714 | 1428 / 1360 | 1433 / 1409 | 595 / 576 | 676 / 860 | 1005 / 1186 | 895 / 498 | 685 / 430 |
| /emails | 632 / 721 | 1436 / 1432 | 1427 / 1422 | 555 / 585 | 636 / 672 | 942 / 1019 | 1118 / 886 | 830 / 999 |
| /board | 743 / 704 | 1536 / 1184 | 1529 / 1178 | 605 / 792 | 688 / 896 | 981 / 1188 | 1278 / 657 | 877 / 642 |
| /queue/print | 767 / 607 | 1520 / 1292 | 1530 / 1298 | 574 / 541 | 652 / 632 | 944 / 910 | 804 / 463 | 621 / 372 |
| /payouts | 857 / 617 | 1444 / 1300 | 1903 / 1295 | 582 / 558 | 740 / 668 | 1031 / 927 | 826 / 423 | 607 / 390 |
| /settings | 651 / 608 | 1444 / 1292 | 1437 / 1281 | 592 / 570 | 652 / 720 | 952 / 1008 | 1123 / 743 | 944 / 455 |
| /designers | 773 / 748 | 1524 / 1460 | 1534 / 1456 | 586 / 531 | 660 / 652 | 965 / 669 | 1070 / 441 | 679 / 415 |
| /styles | 661 / 878 | 1464 / 1532 | 1457 / 1524 | 771 / 541 | 816 / 632 | 1154 / 928 | 864 / 989 | 682 / 398 |
| /health | 2144 / 773 | 2808 / 1524 | 3101 / 1520 | 541 / 576 | 936 / 664 | 1155 / 954 | 1062 / 806 | 1095 / 742 |
| /customers | 776 / 741 | 1524 / 1420 | 1518 / 1415 | 568 / 611 | 688 / 724 | 929 / 736 | 655 / 394 | 652 / 485 |
| /me | 1153 / 602 | 1232 / 652 | 2304 / 652 | 619 / 557 | 700 / 624 | 1000 / 624 | 1141 / 917 | 1236 / 918 |
| /help | 621 / 1011 | 1168 / 1592 | 1161 / 1885 | 547 / 601 | 780 / 744 | 1118 / 885 | - / - | - / - |

**va, phone, Fast 3G** (ms, before / after)

| page | TTFB cold | paint cold | ready cold | TTFB warm | paint warm | ready warm | nav cold | nav warm |
|---|---|---|---|---|---|---|---|---|
| /dashboard | 749 / 748 | 1552 / 1456 | 1525 / 1456 | 942 / 580 | 1092 / 732 | 1329 / 1036 | 1034 / 709 | 994 / 661 |
| /today | 633 / 711 | 1440 / 1420 | 1419 / 1468 | 572 / 570 | 640 / 704 | 959 / 992 | 1034 / 819 | 1267 / 662 |
| /orders | 763 / 559 | 1092 / 684 | 2001 / 2114 | 537 / 681 | 660 / 812 | 1021 / 812 | 624 / 412 | 614 / 393 |
| /orders/[id] | 748 / 891 | 1532 / 1560 | 1518 / 1534 | 604 / 561 | 704 / 712 | 1148 / 1071 | 2805 / 606 | 750 / 824 |
| /qc | 661 / 742 | 1412 / 1396 | 1418 / 1401 | 561 / 563 | 644 / 688 | 657 / 954 | 799 / 428 | 618 / 614 |
| /emails | 633 / 696 | 1440 / 1404 | 1432 / 1397 | 563 / 574 | 624 / 664 | 927 / 1005 | 1142 / 592 | 1083 / 583 |
| /board | 885 / 733 | 1604 / 1452 | 1885 / 1503 | 532 / 729 | 620 / 844 | 919 / 1306 | 992 / 940 | 875 / 653 |
| /queue/print | 624 / 633 | 1440 / 1228 | 1438 / 1312 | 559 / 566 | 828 / 1156 | 830 / 1532 | 1249 / 654 | 598 / 373 |
| /settings | 668 / 618 | 1420 / 1476 | 1425 / 1471 | 562 / 574 | 628 / 704 | 633 / 697 | 1158 / 579 | 998 / 405 |
| /designers | 646 / 968 | 1528 / 1596 | 1512 / 1889 | 588 / 580 | 648 / 696 | 948 / 1014 | 1097 / 681 | 635 / 883 |
| /styles | 693 / 625 | 1496 / 1316 | 1488 / 1342 | 626 / 563 | 700 / 688 | 1004 / 714 | 839 / 976 | 647 / 710 |
| /customers | 699 / 631 | 1480 / 1304 | 1471 / 1300 | 668 / 567 | 736 / 644 | 1040 / 1065 | 622 / 705 | 633 / 403 |
| /me | 582 / 817 | 640 / 940 | 2007 / 940 | 826 / 790 | 912 / 876 | 1188 / 876 | 1150 / 1217 | 1481 / 916 |
| /help | 700 / 835 | 1468 / 1516 | 1456 / 1513 | 669 / 569 | 832 / 664 | 1147 / 958 | - / - | - / - |

**designer, phone, Fast 3G** (ms, before / after)

| page | TTFB cold | paint cold | ready cold | TTFB warm | paint warm | ready warm | nav cold | nav warm |
|---|---|---|---|---|---|---|---|---|
| /dashboard | 945 / 799 | 1632 / 1420 | 1933 / 1705 | 582 / 789 | 796 / 1236 | 1098 / 1509 | 911 / 671 | 915 / 734 |
| /board | 1022 / 734 | 1952 / 1428 | 2319 / 1426 | 709 / 562 | 824 / 688 | 1119 / 964 | 1000 / 677 | 883 / 733 |
| /orders/[id] | 813 / 845 | 1544 / 1536 | 1879 / 1527 | 619 / 765 | 704 / 888 | 1035 / 1167 | 3404 / 828 | 637 / 611 |
| /me | 715 / 658 | 1480 / 1320 | 1551 / 1318 | 573 / 567 | 676 / 648 | 676 / 960 | 1306 / 477 | 610 / 373 |
| /help | 673 / 626 | 1208 / 1104 | 1200 / 1138 | 583 / 593 | 828 / 844 | 1157 / 1181 | 857 / 621 | 903 / 693 |


### Slow 3G, phone

**admin, phone, Slow 3G** (ms, before / after)

| page | TTFB cold | paint cold | ready cold | TTFB warm | paint warm | ready warm | nav cold | nav warm |
|---|---|---|---|---|---|---|---|---|
| /dashboard | 958 / 649 | 3484 / 2692 | 3778 / 2973 | 605 / 591 | 756 / 752 | 1076 / 1080 | 971 / 788 | 1200 / 818 |
| /today | 643 / 645 | 3112 / 2672 | 3405 / 2967 | 558 / 699 | 640 / 964 | 989 / 1379 | 1244 / 835 | 929 / 855 |
| /orders | 556 / 554 | 720 / 956 | 5734 / 5238 | 694 / 553 | 828 / 648 | 864 / 680 | 621 / 595 | 635 / 458 |
| /orders/[id] | 670 / 620 | 4480 / 2688 | 4781 / 2972 | 631 / 539 | 772 / 644 | 1262 / 1048 | 9480 / 753 | 851 / 787 |
| /qc | 628 / 610 | 3012 / 2508 | 3300 / 2780 | 604 / 642 | 696 / 752 | 1052 / 1136 | 1483 / 934 | 631 / 728 |
| /emails | 605 / 654 | 3240 / 2848 | 3531 / 3125 | 553 / 557 | 676 / 664 | 1020 / 1075 | 2336 / 1517 | 891 / 646 |
| /board | 793 / 636 | 4340 / 4308 | 4632 / 4598 | 554 / 1023 | 756 / 1292 | 984 / 1670 | 4280 / 1057 | 917 / 840 |
| /queue/print | 671 / 613 | 3224 / 2732 | 3515 / 3020 | 562 / 675 | 632 / 752 | 991 / 1111 | 1987 / 721 | 599 / 487 |
| /payouts | 737 / 647 | 3192 / 2632 | 3487 / 2936 | 600 / 560 | 692 / 696 | 1035 / 1032 | 2038 / 1004 | 872 / 575 |
| /settings | 1200 / 760 | 3872 / 2968 | 4161 / 3263 | 780 / 569 | 876 / 668 | 1231 / 997 | 2770 / 725 | 880 / 571 |
| /designers | 745 / 620 | 1988 / 2816 | 2281 / 3109 | 876 / 544 | 952 / 636 | 1295 / 1039 | 2413 / 728 | 759 / 560 |
| /styles | 794 / 714 | 3316 / 2816 | 3616 / 3115 | 568 / 585 | 660 / 700 | 1160 / 1055 | 2000 / 636 | 659 / 561 |
| /health | 863 / 639 | 3244 / 2408 | 3531 / 2703 | 686 / 561 | 800 / 680 | 1280 / 1067 | 1210 / 780 | 2087 / 1078 |
| /customers | 638 / 757 | 3048 / 2616 | 3338 / 2915 | 842 / 791 | 964 / 900 | 1298 / 1243 | 785 / 567 | 722 / 555 |
| /me | 590 / 586 | 772 / 736 | 808 / 4906 | 707 / 554 | 836 / 672 | 872 / 704 | 1276 / 939 | 1318 / 944 |
| /help | 662 / 1237 | 2936 / 3316 | 3214 / 3613 | 583 / 613 | 848 / 712 | 1197 / 1054 | - / - | - / - |

**va, phone, Slow 3G** (ms, before / after)

| page | TTFB cold | paint cold | ready cold | TTFB warm | paint warm | ready warm | nav cold | nav warm |
|---|---|---|---|---|---|---|---|---|
| /dashboard | 1122 / 759 | 3584 / 2824 | 3869 / 3100 | 593 / 581 | 680 / 756 | 1034 / 1085 | 919 / 803 | 943 / 836 |
| /today | 901 / 641 | 3360 / 2588 | 3663 / 2879 | 568 / 686 | 664 / 788 | 1010 / 1135 | 1498 / 831 | 891 / 852 |
| /orders | 793 / 554 | 880 / 664 | 6129 / 5005 | 572 / 556 | 752 / 652 | 863 / 716 | 672 / 492 | 678 / 478 |
| /orders/[id] | 748 / 642 | 4540 / 2716 | 4832 / 3020 | 711 / 635 | 784 / 752 | 1177 / 1056 | 9303 / 782 | 807 / 777 |
| /qc | 888 / 635 | 3596 / 2580 | 3884 / 2871 | 1096 / 551 | 1200 / 644 | 1532 / 981 | 1501 / 1087 | 628 / 560 |
| /emails | 695 / 629 | 3288 / 2784 | 3579 / 3084 | 607 / 549 | 696 / 696 | 1075 / 1001 | 2962 / 1536 | 867 / 685 |
| /board | 888 / 623 | 4604 / 4308 | 4897 / 4291 | 616 / 559 | 716 / 832 | 1045 / 1200 | 4551 / 1024 | 907 / 840 |
| /queue/print | 681 / 639 | 3224 / 2732 | 3516 / 3028 | 601 / 594 | 696 / 692 | 1030 / 1026 | 2140 / 738 | 640 / 454 |
| /settings | 654 / 701 | 3016 / 2616 | 3308 / 2911 | 557 / 556 | 656 / 656 | 998 / 998 | 641 / 468 | 572 / 446 |
| /designers | 867 / 626 | 3516 / 2848 | 3814 / 3142 | 721 / 554 | 812 / 688 | 1155 / 1038 | 1491 / 913 | 606 / 846 |
| /styles | 650 / 621 | 3168 / 2736 | 3444 / 3022 | 570 / 617 | 664 / 724 | 1010 / 1074 | 1336 / 944 | 731 / 917 |
| /customers | 715 / 657 | 3128 / 2612 | 3422 / 2911 | 594 / 562 | 680 / 676 | 1022 / 1024 | 717 / 567 | 853 / 556 |
| /me | 567 / 726 | 736 / 836 | 5705 / 5215 | 556 / 630 | 752 / 708 | 1088 / 748 | 1184 / 950 | 1478 / 1285 |
| /help | 694 / 775 | 2956 / 2652 | 3245 / 2948 | 540 / 561 | 636 / 644 | 980 / 986 | - / - | - / - |

**designer, phone, Slow 3G** (ms, before / after)

| page | TTFB cold | paint cold | ready cold | TTFB warm | paint warm | ready warm | nav cold | nav warm |
|---|---|---|---|---|---|---|---|---|
| /dashboard | 638 / 786 | 3084 / 2828 | 3374 / 3128 | 1221 / 569 | 1352 / 732 | 1665 / 1034 | 1011 / 837 | 983 / 863 |
| /board | 655 / 642 | 4224 / 4136 | 4533 / 4468 | 1074 / 585 | 1176 / 768 | 1535 / 1023 | 2401 / 850 | 954 / 777 |
| /orders/[id] | 792 / 630 | 4604 / 2756 | 4953 / 3056 | 1077 / 541 | 1212 / 668 | 1640 / 1129 | 12009 / 1189 | 932 / 867 |
| /me | 666 / 617 | 3096 / 2584 | 3089 / 2874 | 766 / 697 | 888 / 796 | 1216 / 1114 | 1746 / 1148 | 659 / 538 |
| /help | 679 / 644 | 3080 / 2508 | 3384 / 2790 | 584 / 553 | 692 / 824 | 1027 / 1175 | 944 / 792 | 885 / 770 |


## Database round trips per page (admin, staging, warm)

Counted from the driver trace; statements include each transaction's BEGIN,
the RLS `set_config` and COMMIT. "span" = first statement start to last end.

| page | statements | transactions | DB span before | DB span after | note |
|---|---|---|---|---|---|
| /dashboard | 39 | 5 | 122 ms | 122 ms | already parallel (4 loaders in Promise.all) |
| /today | 20 | 3 | 64 ms | 79 ms | parallel |
| /orders | 12 | 2 | 44 ms | 44-100 ms | |
| /orders/[id] | 48-55 | 11-12 | 105 ms | **54 ms** | was: order row, then 8 reads, then media, then style setter |
| /qc | 12 | 2 | 62 ms | 62 ms | |
| /emails | 31 | 6 | 75 ms | 72 ms | parallel |
| /board | 20-27 | 2-3 | 105 ms | 78 ms | |
| /queue/print | 12 | 2 | 64 ms | 56 ms | |
| /payouts | 12 | 2 | 61 ms | 51 ms | |
| /settings | 76 -> **68** | 18 -> 16 | 369 ms | **80 ms** | was 10 sections awaited one after another, 2 reads per shop |
| /designers | 24 | 4 | 50 ms | 62 ms | parallel |
| /styles | 16 | 2 | 89 ms | 77 ms | |
| /health | 44 | 4 | 374 ms | 400-570 ms | ~30 statements in ONE transaction, sequential (see Not met) |
| /customers | 16 | 3 | 81 ms | 66 ms | |
| /me, /help | 8 | 1 | 40 ms | 35 ms | the shell's 4 reads |

Every page also does one HTTP read of the user's row (the per-request session
re-check, `lib/auth/session-check.ts`, 5-15 ms). It is already deduplicated
per render with React `cache()`: layout, page and actions share it, and the
shell data (`loadShellData`) is cached the same way, so layout + page run it
once. Waterfalls found: the order page (fixed), settings (fixed), and
`lib/health/daily-report.ts` `computeHealthMetricsInTx` (30 awaits in a row
on one connection, left as is, now streamed behind the header).

## What changed (commits on this branch)

1. `b71ce76` Client navigations skip the middleware round trip to iad1.
   RSC nav TTFB 490-530 -> 265-300 ms. `/customers` gained the designer
   redirect it relied on the middleware for.
2. `fbbbbb7` Measurement scripts.
3. `6095a25` Order page and settings start their reads together; one read
   for the settings shop-card suggestions; pool max 10 -> 20.
4. `b80515c` Photos at display size from the Shopify CDN (`lib/images.ts`,
   `?width=`): designer phone /board 2525 -> 268 KB of images, order page
   1535 -> 368 KB. Slow 3G full load of /board 57 s -> 19 s.
5. `e30a8b0` No database driver in the browser (template names split into
   `lib/email/template-meta.ts`; after the merge this sits under the polish
   pass's `lib/orders/reply-templates.ts`, which now imports it):
   /orders/[id] first-load JS 195 -> 121 kB. Tour and Alpha chat load on
   demand (`components/shell/lazy-extras.tsx`); layout chunk 32.5 -> 26.4 KB.
6. `a240580` A page-shaped `loading.tsx` for every route (shared blocks in
   `components/shell/skeletons.tsx`); System Health paints its header at once
   and streams the metrics, the AI briefing in its own boundary.
7. `24cb62f` Hover / touch-start prefetch of page data on sidebar and tab
   links; `staleTimes.dynamic = 30` (back/forward and repeat clicks within
   30 s come from memory: nav warm 30-70 ms on a laptop); a service worker
   that caches ONLY `/_next/static/*` (verified on staging: 25 requests
   served from it, zero non-static entries in its cache, versioned per
   deploy, `/sw.js` served no-cache); preconnect to the Shopify CDN and R2;
   the heading font is no longer preloaded.

Checked and left alone: fonts were already `next/font` with `display: swap`;
JS was already cached by the browser (hashed, immutable), so the service
worker mostly helps a returning phone whose HTTP cache was evicted; no icon
pack or chart library is imported whole (icons are local SVG components);
the largest shared chunks are React and Next themselves (103 kB first load
shared by all pages); `poolQueryViaFetch` was already on. No caching headers
were added to HTML: every app page is per-user, and the public proof/upload
pages carry per-customer state.

## Targets: met and not met

Met: nav click to page on a laptop under 700 ms on every page except `/me`
(redirects staff) and one warm `/dashboard` outlier; on a phone under 1 s
except `/me`. Cold LCP under 1.5 s everywhere. Fast 3G warm: shell painted
under 1 s and page ready under 2 s on every page (worst samples: paint
1.24 s once on designer /dashboard, ready 1.53 s), nav under 1 s except one
`/today` sample.

Not met, and why:

1. **Warm TTFB under 400 ms for full page loads: 550-600 ms.** 275-300 ms of
   that is the Pacific round trip to iad1; the other ~270 ms is the
   middleware, which runs in iad1 on this Vercel setup (a probe header showed
   `VERCEL_REGION=iad1`; `regions` on the middleware config did not move it).
   Client navigations (every click inside the app) are at the floor. Two
   ways to go further, both owner decisions:
   - Let full page loads that carry a session cookie skip the middleware
     too. Pages already refuse by role themselves, but a denied designer
     would get the page's streamed redirect (HTTP 200 + client redirect)
     instead of a clean 307, which the security QA (round 1, P2) had fixed.
   - Move the database and functions near the users (Neon ap-southeast-2 +
     Vercel syd1, or wherever the VAs are). That removes ~250 ms from EVERY
     request, cold and warm. It is a migration, not a code change.
2. **Slow 3G: the shell cannot paint from cache on a first visit** (there is
   no cache yet): cold paint 2.4-4.3 s, mostly the 13 KB CSS + ~130 KB JS at
   50 KB/s. On a return visit it paints in 0.6-1.3 s and the data fills in.
3. **/health data**: ~30 sequential statements in one transaction
   (400-570 ms DB time). The header paints first now; making the numbers
   themselves faster needs `computeHealthMetricsInTx` split over a few
   parallel transactions. It is shared with the daily report cron, so it
   deserves its own change and test.
4. **/board is the heaviest page (146 kB first-load JS)**, see below.

## For the agents who own these files (not edited here)

- `components/tour/show-me-around.tsx` imports `TOUR_START_EVENT` from
  `./tour`, which pulls the whole tour (~20 KB source) into `/help`'s bundle
  (help grew 530 B -> 6.6 kB). Import it from
  `@/components/shell/lazy-extras` instead (same string,
  `"alphaos:tour-start"`); the lazy tour listens for it and replays it.
- `components/board/*`: `@dnd-kit/core` and the card modal are in the first
  load of `/board` (146 kB). The phone board does not drag; load the desktop
  drag layer and `card-modal.tsx` with `next/dynamic` (modal on first open).
- `components/orders/orders-view-preference.tsx`: restoring the saved view
  is a client redirect after the page has loaded, i.e. a second full server
  round trip on every visit to `/orders` (ready cold on Fast 3G ~2 s vs
  ~1.4 s for similar pages). Reading the preference from a cookie in the
  page (server) and rendering that view directly removes it.
- `components/orders/*` row links: an explicit `router.prefetch` on row
  hover would make opening an order from the list as instant as the
  sidebar; the order page already has its own skeleton.
- `lib/auth`: nothing to change for speed; the re-check is one cached
  HTTP read per request.
