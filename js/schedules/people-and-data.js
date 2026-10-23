/* schedules/people-and-data: methods register before ordered initialization. */
(function (App) {
  "use strict";
App.startSchedulesPeopleListener = function () {
  if (App.schedulesPeopleListener) return;
  const ref = App.db.ref("users");
  const cb = snap => {
    App.schedulesPeopleError = "";
    App.schedulesPeopleSnapshot = snap.exists() ? snap.val() || {} : {};
    App.refreshSchedulesPeople();
  };
  ref.on("value", cb, error => {
    App.schedulesPeopleError = error.message;
    App.schedulesPeopleListener = null;
    App.scheduleRenderSchedulesUI?.();
  });
  App.schedulesPeopleListener = { ref, cb };
};
App.refreshSchedulesPeople = function () {
    const v = App.schedulesPeopleSnapshot || {};
    App.schedulesPeopleLoadedOnce = true;
    const arr = [];
    const byCode = new Map();
    const byUsername = new Map();
    for (const [code, recRaw] of Object.entries(v)) {
      if (!code) continue;
      const rec = recRaw || {};
      if (typeof rec.username !== "string" || !rec.username.trim()) continue;
      const username = rec.username;
      const displayName = String(rec.displayName || username);
      const user = {
        ...rec,
        code,
        username,
        usernameLower: String(rec.usernameLower || username.toLowerCase()),
        displayName,
        displayNameLower: String(rec.displayNameLower || displayName.toLowerCase()),
        photoDataURL: rec.photoDataURL || App.defaultStickmanDataURL(),
        photoTransform: App.normalizeTransformToRel(rec.photoTransform, 84)
      };
      arr.push(user);
      byCode.set(code, user);
      byUsername.set(username, user);
    }

    // Keep configured schedules visible even when their usernames do not have
    // Firebase accounts. Schedule-only people use a consistent name avatar.
    const accountsByUsername = new Map(arr.map(user => [user.usernameLower, user]));
    for (const configuredUsername of Object.keys(App.SCHEDULES || {})) {
      if (!configuredUsername || configuredUsername.startsWith("__")) continue;
      const usernameLower = configuredUsername.toLowerCase();
      const existingAccount = accountsByUsername.get(usernameLower);
      if (existingAccount) {
        byUsername.set(configuredUsername, existingAccount);
        continue;
      }
      const scheduleOnlyUser = {
        code: "",
        username: configuredUsername,
        usernameLower,
        displayName: configuredUsername,
        displayNameLower: usernameLower,
        photoDataURL: App.scheduleNameAvatarDataURL(configuredUsername),
        photoTransform: null,
        scheduleOnly: true
      };
      arr.push(scheduleOnlyUser);
      byUsername.set(configuredUsername, scheduleOnlyUser);
    }
    arr.sort((a, b) => a.usernameLower.localeCompare(b.usernameLower));
    // Activity leases update the user directory frequently. Refresh the roster
    // only when a visible identity or activity changes, preserving fresh lease
    // records without rebuilding every game indicator on each heartbeat.
    const previous = App.schedulesPeopleByCode;
    const rosterChanged = !previous || previous.size !== byCode.size || [...byCode].some(([code, user]) => {
      const old = previous.get(code);
      return !old || ["username", "displayName", "photoDataURL", "notificationStatus"].some(field => old[field] !== user[field]) ||
        JSON.stringify(old.photoTransform) !== JSON.stringify(user.photoTransform) ||
        JSON.stringify(old.adminGhostRooms) !== JSON.stringify(user.adminGhostRooms) ||
        App.getActivityPresenceRenderKey?.(old) !== App.getActivityPresenceRenderKey?.(user);
    });
    App.schedulesPeopleCache = arr;
    App.schedulesPeopleByCode = byCode;
    App.schedulesPeopleByUsername = byUsername;

    // If the currently-open person no longer exists (renamed/deleted), bounce back.
    if (App.schedulesState?.person && !App.schedulesPeopleByUsername.has(String(App.schedulesState.person))) {
      App.schedulesState.person = null;
    }

    // Live refresh if we are on Schedules
    if (App.getStoredPlace() === "schedules") {
      try {
        App.scheduleRenderSchedulesUI();
      } catch {}
    } else if (App.currentRoomId && rosterChanged) {
      try {
        App.queueMemberRosterRender?.();
      } catch {}
    }
};
App.stopSchedulesPeopleListener = function () {
  if (!App.schedulesPeopleListener) return;
  try {
    App.schedulesPeopleListener.ref.off("value", App.schedulesPeopleListener.cb);
  } catch {}
  App.schedulesPeopleListener = null;
  // IMPORTANT: do NOT clear cached people here.
  // Clearing causes "No accounts found" flicker while Firebase reconnects / rehydrates.
};

App.register("schedules/people-and-data", function initializeFeature() {
App.SCHEDULE_DAY_TYPES = [{
  key: "full",
  label: "Full Day"
}, {
  key: "half",
  label: "Half Day"
}, {
  key: "delay2",
  label: "2 HR Delay"
}, {
  key: "noschool",
  label: "No School"
}];
App.schedulesPeopleCache = [];
App.schedulesPeopleByCode = new Map();
App.schedulesPeopleByUsername = new Map();
App.schedulesPeopleListener = null;
App.schedulesPeopleLoadedOnce = false;
App.SCHEDULE_BLOCKS = [{
  key: "P1",
  label: "Period 1"
}, {
  key: "HR",
  label: "Homeroom"
}, {
  key: "P2",
  label: "Period 2"
}, {
  key: "P3",
  label: "Period 3"
}, {
  key: "P4",
  label: "Period 4"
}, {
  key: "P5",
  label: "Period 5"
}, {
  key: "P5A",
  label: "Period 5A"
}, {
  key: "P6",
  label: "Period 6"
}, {
  key: "P7",
  label: "Period 7"
}];
App.SCHEDULE_TIMES = {
  full: {
    HR: {
      time: "8:33 AM - 8:45 AM",
      duration: "12 minutes"
    },
    P1: {
      time: "7:45 AM - 8:30 AM",
      duration: "45 minutes"
    },
    P2: {
      time: "8:48 AM - 9:33 AM",
      duration: "45 minutes"
    },
    P3: {
      time: "9:36 AM - 10:21 AM",
      duration: "45 minutes"
    },
    P4: {
      time: "10:24 AM - 11:09 AM",
      duration: "45 minutes"
    },
    P5: {
      time: "11:12 AM - 11:49 AM",
      duration: "37 minutes"
    },
    P5A: {
      time: "11:52 AM - 12:37 PM",
      duration: "45 minutes"
    },
    P6: {
      time: "12:40 PM - 1:25 PM",
      duration: "45 minutes"
    },
    P7: {
      time: "1:28 PM - 2:13 PM",
      duration: "45 minutes"
    }
  },
  half: {
    HR: {
      time: "",
      duration: ""
    },
    P1: {
      time: "",
      duration: ""
    },
    P2: {
      time: "",
      duration: ""
    },
    P3: {
      time: "",
      duration: ""
    },
    P4: {
      time: "",
      duration: ""
    },
    P5: {
      time: "",
      duration: ""
    },
    P5A: {
      time: "",
      duration: ""
    },
    P6: {
      time: "",
      duration: ""
    },
    P7: {
      time: "",
      duration: ""
    }
  },
  delay2: {
    HR: {
      time: "",
      duration: ""
    },
    P1: {
      time: "",
      duration: ""
    },
    P2: {
      time: "",
      duration: ""
    },
    P3: {
      time: "",
      duration: ""
    },
    P4: {
      time: "",
      duration: ""
    },
    P5: {
      time: "",
      duration: ""
    },
    P5A: {
      time: "",
      duration: ""
    },
    P6: {
      time: "",
      duration: ""
    },
    P7: {
      time: "",
      duration: ""
    }
  }
};
App.SCHEDULES = {
  "Vinny": {
    M: {
      HR: {
        className: "Homeroom",
        teacher: "Michael Hopkins",
        room: "A02"
      },
      P1: {
        className: "Geometry HN",
        teacher: "Matthew Rinaldi",
        room: "C20"
      },
      P2: {
        className: "Spanish",
        teacher: "Megan Getrige",
        room: "B17"
      },
      P3: {
        className: "Civics & Economics",
        teacher: "Gregory Russick",
        room: "C18"
      },
      P4: {
        className: "Biology HN",
        teacher: "Michael Hopkins",
        room: "A02"
      },
      P5: {
        className: "Lunch",
        teacher: "N/A",
        room: "N/A"
      },
      P5A: {
        className: "Art",
        teacher: "Kara Anthony",
        room: "A14"
      },
      P6: {
        className: "Study",
        teacher: "Ava Butcher",
        room: "C02"
      },
      P7: {
        className: "English HN",
        teacher: "Amy Saunders",
        room: "B13"
      }
    },
    T: {
      HR: {
        className: "Homeroom",
        teacher: "Michael Hopkins",
        room: "A02"
      },
      P1: {
        className: "Geometry HN",
        teacher: "Matthew Rinaldi",
        room: "C20"
      },
      P2: {
        className: "Spanish",
        teacher: "Megan Getrige",
        room: "B17"
      },
      P3: {
        className: "Civics & Economics",
        teacher: "Gregory Russick",
        room: "C18"
      },
      P4: {
        className: "Biology HN",
        teacher: "Michael Hopkins",
        room: "A02"
      },
      P5: {
        className: "Lunch",
        teacher: "N/A",
        room: "N/A"
      },
      P5A: {
        className: "Study",
        teacher: "Holly Homschek",
        room: "A10"
      },
      P6: {
        className: "Study",
        teacher: "Kara Anthony",
        room: "A14"
      },
      P7: {
        className: "English HN",
        teacher: "Amy Saunders",
        room: "B13"
      }
    },
    W: {
      HR: {
        className: "Homeroom",
        teacher: "Michael Hopkins",
        room: "A02"
      },
      P1: {
        className: "Geometry HN",
        teacher: "Matthew Rinaldi",
        room: "C20"
      },
      P2: {
        className: "Spanish",
        teacher: "Megan Getrige",
        room: "B17"
      },
      P3: {
        className: "Civics & Economics",
        teacher: "Gregory Russick",
        room: "C18"
      },
      P4: {
        className: "Biology HN",
        teacher: "Michael Hopkins",
        room: "A02"
      },
      P5: {
        className: "Lunch",
        teacher: "N/A",
        room: "N/A"
      },
      P5A: {
        className: "Study",
        teacher: "Holly Homschek",
        room: "A10"
      },
      P6: {
        className: "Music Appreciation",
        teacher: "Adam Burdett",
        room: "F11"
      },
      P7: {
        className: "English HN",
        teacher: "Amy Saunders",
        room: "B13"
      }
    },
    R: {
      HR: {
        className: "Homeroom",
        teacher: "Michael Hopkins",
        room: "A02"
      },
      P1: {
        className: "Geometry HN",
        teacher: "Matthew Rinaldi",
        room: "C20"
      },
      P2: {
        className: "Spanish",
        teacher: "Megan Getrige",
        room: "B17"
      },
      P3: {
        className: "Civics & Economics",
        teacher: "Gregory Russick",
        room: "C18"
      },
      P4: {
        className: "Biology HN",
        teacher: "Michael Hopkins",
        room: "A02"
      },
      P5: {
        className: "Lunch",
        teacher: "N/A",
        room: "N/A"
      },
      P5A: {
        className: "Study",
        teacher: "Danae Kemzura",
        room: "A08"
      },
      P6: {
        className: "Personal Dev/Career Research",
        teacher: "Kara Anthony",
        room: "A14"
      },
      P7: {
        className: "English HN",
        teacher: "Amy Saunders",
        room: "B13"
      }
    },
    F: {
      HR: {
        className: "Homeroom",
        teacher: "Michael Hopkins",
        room: "A02"
      },
      P1: {
        className: "Geometry HN",
        teacher: "Matthew Rinaldi",
        room: "C20"
      },
      P2: {
        className: "Spanish",
        teacher: "Megan Getrige",
        room: "B17"
      },
      P3: {
        className: "Civics & Economics",
        teacher: "Gregory Russick",
        room: "C18"
      },
      P4: {
        className: "Biology HN",
        teacher: "Michael Hopkins",
        room: "A02"
      },
      P5: {
        className: "Lunch",
        teacher: "N/A",
        room: "N/A"
      },
      P5A: {
        className: "Physical Ed",
        teacher: "Kyle Turonis",
        room: "GYM"
      },
      P6: {
        className: "Gen Ind Arts",
        teacher: "Frank Victor",
        room: "B10"
      },
      P7: {
        className: "English HN",
        teacher: "Amy Saunders",
        room: "B13"
      }
    }
  },
  "Caden": {
    M: {
      HR: {
        className: "Homeroom",
        teacher: "Kara Anthony",
        room: "A14"
      },
      P1: {
        className: "Personal Dev/Career Research I",
        teacher: "Kara Anthony",
        room: "A14"
      },
      P2: {
        className: "Spanish I",
        teacher: "Kimberly Collins",
        room: "A01"
      },
      P3: {
        className: "Algebra II",
        teacher: "Kimberly Endres",
        room: "C05"
      },
      P4: {
        className: "Biology HN",
        teacher: "Michael Hopkins",
        room: "A02"
      },
      P5: {
        className: "Lunch",
        teacher: "N/A",
        room: "N/A"
      },
      P5A: {
        className: "Music Appreciation",
        teacher: "Adam Burdett",
        room: "F11"
      },
      P6: {
        className: "English I",
        teacher: "Jennifer Mattingly",
        room: "C19"
      },
      P7: {
        className: "Civics & Economics",
        teacher: "Michael Fuller",
        room: "B14"
      }
    },
    T: {
      HR: {
        className: "Homeroom",
        teacher: "Kara Anthony",
        room: "A14"
      },
      P1: {
        className: "Art I",
        teacher: "Kara Anthony",
        room: "A14"
      },
      P2: {
        className: "Spanish I",
        teacher: "Kimberly Collins",
        room: "A01"
      },
      P3: {
        className: "Algebra II",
        teacher: "Kimberly Endres",
        room: "C05"
      },
      P4: {
        className: "Biology HN",
        teacher: "Michael Hopkins",
        room: "A02"
      },
      P5: {
        className: "Lunch",
        teacher: "N/A",
        room: "N/A"
      },
      P5A: {
        className: "Gen Ind Arts",
        teacher: "Frank Victor",
        room: "B10"
      },
      P6: {
        className: "English I",
        teacher: "Jennifer Mattingly",
        room: "C19"
      },
      P7: {
        className: "Civics & Economics",
        teacher: "Michael Fuller",
        room: "B14"
      }
    },
    W: {
      HR: {
        className: "Homeroom",
        teacher: "Kara Anthony",
        room: "A14"
      },
      P1: {
        className: "Study",
        teacher: "Cathryn Turner",
        room: "B15"
      },
      P2: {
        className: "Spanish I",
        teacher: "Kimberly Collins",
        room: "A01"
      },
      P3: {
        className: "Algebra II",
        teacher: "Kimberly Endres",
        room: "C05"
      },
      P4: {
        className: "Biology HN",
        teacher: "Michael Hopkins",
        room: "A02"
      },
      P5: {
        className: "Lunch",
        teacher: "N/A",
        room: "N/A"
      },
      P5A: {
        className: "Study",
        teacher: "Holly Homschek",
        room: "A10"
      },
      P6: {
        className: "English I",
        teacher: "Jennifer Mattingly",
        room: "C19"
      },
      P7: {
        className: "Civics & Economics",
        teacher: "Michael Fuller",
        room: "B14"
      }
    },
    R: {
      HR: {
        className: "Homeroom",
        teacher: "Kara Anthony",
        room: "A14"
      },
      P1: {
        className: "Physical Ed 9-10",
        teacher: "Kyle Turonis",
        room: "GYM"
      },
      P2: {
        className: "Spanish I",
        teacher: "Kimberly Collins",
        room: "A01"
      },
      P3: {
        className: "Algebra II",
        teacher: "Kimberly Endres",
        room: "C05"
      },
      P4: {
        className: "Biology HN",
        teacher: "Michael Hopkins",
        room: "A02"
      },
      P5: {
        className: "Lunch",
        teacher: "N/A",
        room: "N/A"
      },
      P5A: {
        className: "Study",
        teacher: "Holly Homschek",
        room: "A10"
      },
      P6: {
        className: "English I",
        teacher: "Jennifer Mattingly",
        room: "C19"
      },
      P7: {
        className: "Civics & Economics",
        teacher: "Michael Fuller",
        room: "B14"
      }
    },
    F: {
      HR: {
        className: "Homeroom",
        teacher: "Kara Anthony",
        room: "A14"
      },
      P1: {
        className: "Study",
        teacher: "Amanda Bauman",
        room: "C07"
      },
      P2: {
        className: "Spanish I",
        teacher: "Kimberly Collins",
        room: "A01"
      },
      P3: {
        className: "Algebra II",
        teacher: "Kimberly Endres",
        room: "C05"
      },
      P4: {
        className: "Biology HN",
        teacher: "Michael Hopkins",
        room: "A02"
      },
      P5: {
        className: "Lunch",
        teacher: "N/A",
        room: "N/A"
      },
      P5A: {
        className: "Study",
        teacher: "Holly Homschek",
        room: "A10"
      },
      P6: {
        className: "English I",
        teacher: "Jennifer Mattingly",
        room: "C19"
      },
      P7: {
        className: "Civics & Economics",
        teacher: "Michael Fuller",
        room: "B14"
      }
    }
  },
  "William": {
    M: {
      HR: {
        className: "Homeroom",
        teacher: "Gabrielle Mazar",
        room: "A07"
      },
      P1: {
        className: "English",
        teacher: "Jennifer Mattingly",
        room: "C19"
      },
      P2: {
        className: "Gen Science",
        teacher: "Amanda Bauman",
        room: "C07"
      },
      P3: {
        className: "Study",
        teacher: "Wendy Sutton",
        room: "C06"
      },
      P4: {
        className: "Physical Ed",
        teacher: "Kyle Turonis",
        room: "GYM"
      },
      P5: {
        className: "Lunch",
        teacher: "N/A",
        room: "N/A"
      },
      P5A: {
        className: "Conversational Spanish",
        teacher: "Wendy Sutton",
        room: "C06"
      },
      P6: {
        className: "Essentials of Algebra",
        teacher: "Jarryd Lokuta",
        room: "A11"
      },
      P7: {
        className: "Civics & Economics",
        teacher: "Michael Fuller",
        room: "B14"
      }
    },
    T: {
      HR: {
        className: "Homeroom",
        teacher: "Gabrielle Mazar",
        room: "A07"
      },
      P1: {
        className: "English",
        teacher: "Jennifer Mattingly",
        room: "C19"
      },
      P2: {
        className: "Gen Science",
        teacher: "Amanda Bauman",
        room: "C07"
      },
      P3: {
        className: "Personal Dev/Career Research",
        teacher: "Kara Anthony",
        room: "A14"
      },
      P4: {
        className: "Art",
        teacher: "Kara Anthony",
        room: "A14"
      },
      P5: {
        className: "Lunch",
        teacher: "N/A",
        room: "N/A"
      },
      P5A: {
        className: "Conversational Spanish",
        teacher: "Wendy Sutton",
        room: "C06"
      },
      P6: {
        className: "Essentials of Algebra",
        teacher: "Jarryd Lokuta",
        room: "A11"
      },
      P7: {
        className: "Civics & Economics",
        teacher: "Michael Fuller",
        room: "B14"
      }
    },
    W: {
      HR: {
        className: "Homeroom",
        teacher: "Gabrielle Mazar",
        room: "A07"
      },
      P1: {
        className: "English",
        teacher: "Jennifer Mattingly",
        room: "C19"
      },
      P2: {
        className: "Gen Science",
        teacher: "Amanda Bauman",
        room: "C07"
      },
      P3: {
        className: "Study",
        teacher: "Nicole Dohman",
        room: "B11"
      },
      P4: {
        className: "Study",
        teacher: "Pamela Kobierecki",
        room: "B04"
      },
      P5: {
        className: "Lunch",
        teacher: "N/A",
        room: "N/A"
      },
      P5A: {
        className: "Conversational Spanish",
        teacher: "Wendy Sutton",
        room: "C06"
      },
      P6: {
        className: "Essentials of Algebra",
        teacher: "Jarryd Lokuta",
        room: "A11"
      },
      P7: {
        className: "Civics & Economics",
        teacher: "Michael Fuller",
        room: "B14"
      }
    },
    R: {
      HR: {
        className: "Homeroom",
        teacher: "Gabrielle Mazar",
        room: "A07"
      },
      P1: {
        className: "English",
        teacher: "Jennifer Mattingly",
        room: "C19"
      },
      P2: {
        className: "Gen Science",
        teacher: "Amanda Bauman",
        room: "C07"
      },
      P3: {
        className: "Music Appreciation",
        teacher: "Adam Burdett",
        room: "F11"
      },
      P4: {
        className: "Gen Ind Arts",
        teacher: "Frank Victor",
        room: "B10"
      },
      P5: {
        className: "Lunch",
        teacher: "N/A",
        room: "N/A"
      },
      P5A: {
        className: "Conversational Spanish",
        teacher: "Wendy Sutton",
        room: "C06"
      },
      P6: {
        className: "Essentials of Algebra",
        teacher: "Jarryd Lokuta",
        room: "A11"
      },
      P7: {
        className: "Civics & Economics",
        teacher: "Michael Fuller",
        room: "B14"
      }
    },
    F: {
      HR: {
        className: "Homeroom",
        teacher: "Gabrielle Mazar",
        room: "A07"
      },
      P1: {
        className: "English",
        teacher: "Jennifer Mattingly",
        room: "C19"
      },
      P2: {
        className: "Gen Science",
        teacher: "Amanda Bauman",
        room: "C07"
      },
      P3: {
        className: "Study",
        teacher: "Wendy Sutton",
        room: "C06"
      },
      P4: {
        className: "Study",
        teacher: "Alicia McAndrew",
        room: "A03"
      },
      P5: {
        className: "Lunch",
        teacher: "N/A",
        room: "N/A"
      },
      P5A: {
        className: "Conversational Spanish",
        teacher: "Wendy Sutton",
        room: "C06"
      },
      P6: {
        className: "Essentials of Algebra",
        teacher: "Jarryd Lokuta",
        room: "A11"
      },
      P7: {
        className: "Civics & Economics",
        teacher: "Michael Fuller",
        room: "B14"
      }
    }
  },
  "Giuseppe": {
    M: {
      HR: {
        className: "Homeroom",
        teacher: "Kara Anthony",
        room: "A14"
      },
      P1: {
        className: "Spanish",
        teacher: "Kimberly Collins",
        room: "A01"
      },
      P2: {
        className: "Geometry HN",
        teacher: "Matthew Rinaldi",
        room: "C20"
      },
      P3: {
        className: "Civics & Economics",
        teacher: "Gregory Russick",
        room: "C18"
      },
      P4: {
        className: "Biology HN",
        teacher: "Fallon Plis",
        room: "C12"
      },
      P5: {
        className: "Lunch",
        teacher: "N/A",
        room: "N/A"
      },
      P5A: {
        className: "Music Appreciation",
        teacher: "Adam Burdett",
        room: "F11"
      },
      P6: {
        className: "Gen Ind Arts",
        teacher: "Frank Victor",
        room: "B10"
      },
      P7: {
        className: "English HN",
        teacher: "Amy Saunders",
        room: "B13"
      }
    },
    T: {
      HR: {
        className: "Homeroom",
        teacher: "Kara Anthony",
        room: "A14"
      },
      P1: {
        className: "Spanish",
        teacher: "Kimberly Collins",
        room: "A01"
      },
      P2: {
        className: "Geometry HN",
        teacher: "Matthew Rinaldi",
        room: "C20"
      },
      P3: {
        className: "Civics & Economics",
        teacher: "Gregory Russick",
        room: "C18"
      },
      P4: {
        className: "Biology HN",
        teacher: "Fallon Plis",
        room: "C12"
      },
      P5: {
        className: "Lunch",
        teacher: "N/A",
        room: "N/A"
      },
      P5A: {
        className: "Art",
        teacher: "Kara Anthony",
        room: "A14"
      },
      P6: {
        className: "Study",
        teacher: "Kyle Turonis",
        room: "C03"
      },
      P7: {
        className: "English HN",
        teacher: "Amy Saunders",
        room: "B13"
      }
    },
    W: {
      HR: {
        className: "Homeroom",
        teacher: "Kara Anthony",
        room: "A14"
      },
      P1: {
        className: "Spanish",
        teacher: "Kimberly Collins",
        room: "A01"
      },
      P2: {
        className: "Geometry HN",
        teacher: "Matthew Rinaldi",
        room: "C20"
      },
      P3: {
        className: "Civics & Economics",
        teacher: "Gregory Russick",
        room: "C18"
      },
      P4: {
        className: "Biology HN",
        teacher: "Fallon Plis",
        room: "C12"
      },
      P5: {
        className: "Lunch",
        teacher: "N/A",
        room: "N/A"
      },
      P5A: {
        className: "Study",
        teacher: "Amy Saunders",
        room: "B13"
      },
      P6: {
        className: "Study",
        teacher: "Amanda Carmody",
        room: "A05"
      },
      P7: {
        className: "English HN",
        teacher: "Amy Saunders",
        room: "B13"
      }
    },
    R: {
      HR: {
        className: "Homeroom",
        teacher: "Kara Anthony",
        room: "A14"
      },
      P1: {
        className: "Spanish",
        teacher: "Kimberly Collins",
        room: "A01"
      },
      P2: {
        className: "Geometry HN",
        teacher: "Matthew Rinaldi",
        room: "C20"
      },
      P3: {
        className: "Civics & Economics",
        teacher: "Gregory Russick",
        room: "C18"
      },
      P4: {
        className: "Biology HN",
        teacher: "Fallon Plis",
        room: "C12"
      },
      P5: {
        className: "Lunch",
        teacher: "N/A",
        room: "N/A"
      },
      P5A: {
        className: "Study",
        teacher: "Michael Hopkins",
        room: "A02"
      },
      P6: {
        className: "Personal Dev/Career Research",
        teacher: "Kara Anthony",
        room: "A14"
      },
      P7: {
        className: "English HN",
        teacher: "Amy Saunders",
        room: "B13"
      }
    },
    F: {
      HR: {
        className: "Homeroom",
        teacher: "Kara Anthony",
        room: "A14"
      },
      P1: {
        className: "Spanish",
        teacher: "Kimberly Collins",
        room: "A01"
      },
      P2: {
        className: "Geometry HN",
        teacher: "Matthew Rinaldi",
        room: "C20"
      },
      P3: {
        className: "Civics & Economics",
        teacher: "Gregory Russick",
        room: "C18"
      },
      P4: {
        className: "Biology HN",
        teacher: "Fallon Plis",
        room: "C12"
      },
      P5: {
        className: "Lunch",
        teacher: "N/A",
        room: "N/A"
      },
      P5A: {
        className: "Study",
        teacher: "Frank Victor",
        room: "B10"
      },
      P6: {
        className: "Physical Ed",
        teacher: "Frank Barbrie",
        room: "GYM"
      },
      P7: {
        className: "English HN",
        teacher: "Amy Saunders",
        room: "B13"
      }
    }
  },
  "TJ": {
    M: {
      HR: {
        className: "Homeroom",
        teacher: "Michael Hopkins",
        room: "A02"
      },
      P1: {
        className: "Civics & Economics",
        teacher: "Michael Fuller",
        room: "B14"
      },
      P2: {
        className: "Study",
        teacher: "Kathryn Aston",
        room: "C04"
      },
      P3: {
        className: "Spanish",
        teacher: "Megan Getrige",
        room: "B17"
      },
      P4: {
        className: "Biology HN",
        teacher: "Fallon Plis",
        room: "C12"
      },
      P5: {
        className: "Lunch",
        teacher: "N/A",
        room: "N/A"
      },
      P5A: {
        className: "Art",
        teacher: "Kara Anthony",
        room: "A14"
      },
      P6: {
        className: "Algebra I",
        teacher: "Nick Barbieri",
        room: "A18"
      },
      P7: {
        className: "English HN",
        teacher: "Amy Saunders",
        room: "B13"
      }
    },
    T: {
      HR: {
        className: "Homeroom",
        teacher: "Michael Hopkins",
        room: "A02"
      },
      P1: {
        className: "Civics & Economics",
        teacher: "Michael Fuller",
        room: "B14"
      },
      P2: {
        className: "Gen Ind Arts",
        teacher: "Frank Victor",
        room: "B10"
      },
      P3: {
        className: "Spanish",
        teacher: "Megan Getrige",
        room: "B17"
      },
      P4: {
        className: "Biology HN",
        teacher: "Fallon Plis",
        room: "C12"
      },
      P5: {
        className: "Lunch",
        teacher: "N/A",
        room: "N/A"
      },
      P5A: {
        className: "Study",
        teacher: "Danae Kemzura",
        room: "A08"
      },
      P6: {
        className: "Algebra I",
        teacher: "Nick Barbieri",
        room: "A18"
      },
      P7: {
        className: "English HN",
        teacher: "Amy Saunders",
        room: "B13"
      }
    },
    W: {
      HR: {
        className: "Homeroom",
        teacher: "Michael Hopkins",
        room: "A02"
      },
      P1: {
        className: "Civics & Economics",
        teacher: "Michael Fuller",
        room: "B14"
      },
      P2: {
        className: "Personal Dev/Career Research",
        teacher: "Gabrielle Mazar",
        room: "A07"
      },
      P3: {
        className: "Spanish",
        teacher: "Megan Getrige",
        room: "B17"
      },
      P4: {
        className: "Biology HN",
        teacher: "Fallon Plis",
        room: "C12"
      },
      P5: {
        className: "Lunch",
        teacher: "N/A",
        room: "N/A"
      },
      P5A: {
        className: "Study",
        teacher: "Amy Saunders",
        room: "B13"
      },
      P6: {
        className: "Algebra I",
        teacher: "Nick Barbieri",
        room: "A18"
      },
      P7: {
        className: "English HN",
        teacher: "Amy Saunders",
        room: "B13"
      }
    },
    R: {
      HR: {
        className: "Homeroom",
        teacher: "Michael Hopkins",
        room: "A02"
      },
      P1: {
        className: "Civics & Economics",
        teacher: "Michael Fuller",
        room: "B14"
      },
      P2: {
        className: "Study",
        teacher: "Frank Victor",
        room: "B10"
      },
      P3: {
        className: "Spanish",
        teacher: "Megan Getrige",
        room: "B17"
      },
      P4: {
        className: "Biology HN",
        teacher: "Fallon Plis",
        room: "C12"
      },
      P5: {
        className: "Lunch",
        teacher: "N/A",
        room: "N/A"
      },
      P5A: {
        className: "Music Appreciation",
        teacher: "Adam Burdett",
        room: "F11"
      },
      P6: {
        className: "Algebra I",
        teacher: "Nick Barbieri",
        room: "A18"
      },
      P7: {
        className: "English HN",
        teacher: "Amy Saunders",
        room: "B13"
      }
    },
    F: {
      HR: {
        className: "Homeroom",
        teacher: "Michael Hopkins",
        room: "A02"
      },
      P1: {
        className: "Civics & Economics",
        teacher: "Michael Fuller",
        room: "B14"
      },
      P2: {
        className: "Physical Ed",
        teacher: "Kyle Turonis",
        room: "GYM"
      },
      P3: {
        className: "Spanish",
        teacher: "Megan Getrige",
        room: "B17"
      },
      P4: {
        className: "Biology HN",
        teacher: "Fallon Plis",
        room: "C12"
      },
      P5: {
        className: "Lunch",
        teacher: "N/A",
        room: "N/A"
      },
      P5A: {
        className: "Study",
        teacher: "Danae Kemzura",
        room: "A08"
      },
      P6: {
        className: "Algebra I",
        teacher: "Nick Barbieri",
        room: "A18"
      },
      P7: {
        className: "English HN",
        teacher: "Amy Saunders",
        room: "B13"
      }
    }
  },
  "Nick": {
    M: {
      HR: {
        className: "Homeroom",
        teacher: "Michael Hopkins",
        room: "A02"
      },
      P1: {
        className: "Geometry HN",
        teacher: "Matthew Rinaldi",
        room: "C20"
      },
      P2: {
        className: "English HN",
        teacher: "Amy Saunders",
        room: "B13"
      },
      P3: {
        className: "Civics & Economics",
        teacher: "Gregory Russick",
        room: "C18"
      },
      P4: {
        className: "Spanish",
        teacher: "Kimberly Collins",
        room: "A01"
      },
      P5: {
        className: "Lunch",
        teacher: "N/A",
        room: "N/A"
      },
      P5A: {
        className: "Art",
        teacher: "Kara Anthony",
        room: "A14"
      },
      P6: {
        className: "Study",
        teacher: "Adam Burdett",
        room: "F11"
      },
      P7: {
        className: "Biology HN",
        teacher: "Michael Hopkins",
        room: "A02"
      }
    },
    T: {
      HR: {
        className: "Homeroom",
        teacher: "Michael Hopkins",
        room: "A02"
      },
      P1: {
        className: "Geometry HN",
        teacher: "Matthew Rinaldi",
        room: "C20"
      },
      P2: {
        className: "English HN",
        teacher: "Amy Saunders",
        room: "B13"
      },
      P3: {
        className: "Civics & Economics",
        teacher: "Gregory Russick",
        room: "C18"
      },
      P4: {
        className: "Spanish",
        teacher: "Kimberly Collins",
        room: "A01"
      },
      P5: {
        className: "Lunch",
        teacher: "N/A",
        room: "N/A"
      },
      P5A: {
        className: "Gen Ind Arts",
        teacher: "Frank Victor",
        room: "B10"
      },
      P6: {
        className: "Study",
        teacher: "Amanda Carmody",
        room: "A05"
      },
      P7: {
        className: "Biology HN",
        teacher: "Michael Hopkins",
        room: "A02"
      }
    },
    W: {
      HR: {
        className: "Homeroom",
        teacher: "Michael Hopkins",
        room: "A02"
      },
      P1: {
        className: "Geometry HN",
        teacher: "Matthew Rinaldi",
        room: "C20"
      },
      P2: {
        className: "English HN",
        teacher: "Amy Saunders",
        room: "B13"
      },
      P3: {
        className: "Civics & Economics",
        teacher: "Gregory Russick",
        room: "C18"
      },
      P4: {
        className: "Spanish",
        teacher: "Kimberly Collins",
        room: "A01"
      },
      P5: {
        className: "Lunch",
        teacher: "N/A",
        room: "N/A"
      },
      P5A: {
        className: "Study",
        teacher: "Michael Hopkins",
        room: "A02"
      },
      P6: {
        className: "Study",
        teacher: "Fallon Plis",
        room: "C12"
      },
      P7: {
        className: "Biology HN",
        teacher: "Michael Hopkins",
        room: "A02"
      }
    },
    R: {
      HR: {
        className: "Homeroom",
        teacher: "Michael Hopkins",
        room: "A02"
      },
      P1: {
        className: "Geometry HN",
        teacher: "Matthew Rinaldi",
        room: "C20"
      },
      P2: {
        className: "English HN",
        teacher: "Amy Saunders",
        room: "B13"
      },
      P3: {
        className: "Civics & Economics",
        teacher: "Gregory Russick",
        room: "C18"
      },
      P4: {
        className: "Spanish",
        teacher: "Kimberly Collins",
        room: "A01"
      },
      P5: {
        className: "Lunch",
        teacher: "N/A",
        room: "N/A"
      },
      P5A: {
        className: "Music Appreciation",
        teacher: "Adam Burdett",
        room: "F11"
      },
      P6: {
        className: "Personal Dev/Career Research",
        teacher: "Kara Anthony",
        room: "A14"
      },
      P7: {
        className: "Biology HN",
        teacher: "Michael Hopkins",
        room: "A02"
      }
    },
    F: {
      HR: {
        className: "Homeroom",
        teacher: "Michael Hopkins",
        room: "A02"
      },
      P1: {
        className: "Geometry HN",
        teacher: "Matthew Rinaldi",
        room: "C20"
      },
      P2: {
        className: "English HN",
        teacher: "Amy Saunders",
        room: "B13"
      },
      P3: {
        className: "Civics & Economics",
        teacher: "Gregory Russick",
        room: "C18"
      },
      P4: {
        className: "Spanish",
        teacher: "Kimberly Collins",
        room: "A01"
      },
      P5: {
        className: "Lunch",
        teacher: "N/A",
        room: "N/A"
      },
      P5A: {
        className: "Study",
        teacher: "Frank Victor",
        room: "B10"
      },
      P6: {
        className: "Physical Ed",
        teacher: "Frank Barbrie",
        room: "GYM"
      },
      P7: {
        className: "Biology HN",
        teacher: "Michael Hopkins",
        room: "A02"
      }
    }
  },
  "AJ": {
    M: {
      P1: {
        className: "Anatomy & Physiology HN",
        teacher: "John Richards",
        room: "C16"
      },
      HR: {
        className: "Homeroom",
        teacher: "Fallon Plis",
        room: "C12"
      },
      P2: {
        className: "Study",
        teacher: "Kathryn Aston",
        room: "C04"
      },
      P3: {
        className: "Study",
        teacher: "Nicole Dohman",
        room: "B11"
      },
      P4: {
        className: "Trig & College Algebra",
        teacher: "Carolyn Cocco",
        room: "C14"
      },
      P5: {
        className: "Open Period",
        teacher: "",
        room: ""
      },
      P5A: {
        className: "English IV HN",
        teacher: "Kelly Vincelli",
        room: "C11"
      },
      P6: {
        className: "AP Psychology",
        teacher: "Erica Bartoli",
        room: "B08"
      },
      P7: {
        className: "Study",
        teacher: "Amy Miller",
        room: "C17"
      }
    },
    T: {
      P1: {
        className: "Anatomy & Physiology HN",
        teacher: "John Richards",
        room: "C16"
      },
      HR: {
        className: "Homeroom",
        teacher: "Fallon Plis",
        room: "C12"
      },
      P2: {
        className: "Seminar 12 A",
        teacher: "Jennifer Molinaro",
        room: "A19"
      },
      P3: {
        className: "Study",
        teacher: "Wendy Sutton",
        room: "C06"
      },
      P4: {
        className: "Trig & College Algebra",
        teacher: "Carolyn Cocco",
        room: "C14"
      },
      P5: {
        className: "Open Period",
        teacher: "",
        room: ""
      },
      P5A: {
        className: "English IV HN",
        teacher: "Kelly Vincelli",
        room: "C11"
      },
      P6: {
        className: "AP Psychology",
        teacher: "Erica Bartoli",
        room: "B08"
      },
      P7: {
        className: "Study",
        teacher: "Kimberly Endres",
        room: "C05"
      }
    },
    W: {
      P1: {
        className: "Anatomy & Physiology HN",
        teacher: "John Richards",
        room: "C16"
      },
      HR: {
        className: "Homeroom",
        teacher: "Fallon Plis",
        room: "C12"
      },
      P2: {
        className: "Physical Ed /Health 12",
        teacher: "Frank Barbrie",
        room: "GYM"
      },
      P3: {
        className: "Study",
        teacher: "Wendy Sutton",
        room: "C06"
      },
      P4: {
        className: "Trig & College Algebra",
        teacher: "Carolyn Cocco",
        room: "C14"
      },
      P5: {
        className: "Open Period",
        teacher: "",
        room: ""
      },
      P5A: {
        className: "English IV HN",
        teacher: "Kelly Vincelli",
        room: "C11"
      },
      P6: {
        className: "AP Psychology",
        teacher: "Erica Bartoli",
        room: "B08"
      },
      P7: {
        className: "Study",
        teacher: "Megan Getrige",
        room: "B17"
      }
    },
    R: {
      P1: {
        className: "Anatomy & Physiology HN",
        teacher: "John Richards",
        room: "C16"
      },
      HR: {
        className: "Homeroom",
        teacher: "Fallon Plis",
        room: "C12"
      },
      P2: {
        className: "Study",
        teacher: "John Richards",
        room: "C16"
      },
      P3: {
        className: "Personal Finance 12",
        teacher: "Jill Oliver",
        room: "LIB"
      },
      P4: {
        className: "Trig & College Algebra",
        teacher: "Carolyn Cocco",
        room: "C14"
      },
      P5: {
        className: "Open Period",
        teacher: "",
        room: ""
      },
      P5A: {
        className: "English IV HN",
        teacher: "Kelly Vincelli",
        room: "C11"
      },
      P6: {
        className: "AP Psychology",
        teacher: "Erica Bartoli",
        room: "B08"
      },
      P7: {
        className: "Study",
        teacher: "Frank Barbrie",
        room: "C03"
      }
    },
    F: {
      P1: {
        className: "Anatomy & Physiology HN",
        teacher: "John Richards",
        room: "C16"
      },
      HR: {
        className: "Homeroom",
        teacher: "Fallon Plis",
        room: "C12"
      },
      P2: {
        className: "Study",
        teacher: "Jennifer Mattingly",
        room: "C19"
      },
      P3: {
        className: "Study",
        teacher: "Wendy Sutton",
        room: "C06"
      },
      P4: {
        className: "Trig & College Algebra",
        teacher: "Carolyn Cocco",
        room: "C14"
      },
      P5: {
        className: "Open Period",
        teacher: "",
        room: ""
      },
      P5A: {
        className: "English IV HN",
        teacher: "Kelly Vincelli",
        room: "C11"
      },
      P6: {
        className: "AP Psychology",
        teacher: "Erica Bartoli",
        room: "B08"
      },
      P7: {
        className: "Study",
        teacher: "Megan Getrige",
        room: "B17"
      }
    }
  }
};
});
})(globalThis.ChatApp);
