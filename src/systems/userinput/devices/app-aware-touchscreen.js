import { paths } from "../paths";
import { Pose } from "../pose";
import { touchIsAssigned, jobIsAssigned, assign, unassign, findByJob, findByTouch } from "./touchscreen/assignments";

const MOVE_CURSOR_JOB = "MOVE CURSOR";
const MOVE_CAMERA_JOB = "MOVE CAMERA";
const FIRST_PINCHER_JOB = "FIRST PINCHER";
const SECOND_PINCHER_JOB = "SECOND PINCHER";

function distance(x1, y1, x2, y2) {
  const dx = x1 - x2;
  const dy = y1 - y2;
  return Math.sqrt(dx * dx + dy * dy);
}

const getCursorController = (() => {
  let cursorController = null;

  return function() {
    if (!cursorController) {
      cursorController = document.querySelector("[cursor-controller]").components["cursor-controller"];
    }

    return cursorController;
  };
})();

function getTouchIntersection(touch, raycaster) {
  const cursorController = getCursorController();

  const rawIntersections = [];
  raycaster.setFromCamera(
    {
      x: (touch.clientX / window.innerWidth) * 2 - 1,
      y: -(touch.clientY / window.innerHeight) * 2 + 1
    },
    document.querySelector("#player-camera").components.camera.camera
  );
  raycaster.intersectObjects(cursorController.targets, true, rawIntersections);
  return rawIntersections.find(x => x.object.el);
}

function isCursorOverInteractable(touch, raycaster) {
  const cursorController = getCursorController();
  const isCursorGrabbing = cursorController.data.cursor.components["super-hands"].state.has("grab-start");
  if (isCursorGrabbing) {
    return true;
  }
  const intersection = getTouchIntersection(touch, raycaster);
  return intersection && intersection.object.el.matches(".interactable, .interactable *");
}

// We delay all first start touches unless the user is on the UI.
//
// This mitigates issues where the user is about to put a second finger down.
function shouldDelayStartTouch(touch, raycaster) {
  const intersection = getTouchIntersection(touch, raycaster);
  return !intersection || !intersection.object.el.matches(".ui, .ui *");
}

export class AppAwareTouchscreenDevice {
  constructor() {
    this.raycaster = new THREE.Raycaster(new THREE.Vector3(), new THREE.Vector3(), 0, 3);
    this.assignments = [];
    this.pinch = { initialDistance: 0, currentDistance: 0, delta: 0 };

    // When touches appear, this timestamps and then watches for the high water mark of # of touches
    this.pendingTap = { maxTouchCount: 0, startedAt: 0 };
    this.tapIndexToWriteNextFrame = 0;

    this.events = [];
    ["touchstart", "touchend", "touchmove", "touchcancel"].map(x =>
      document.querySelector("canvas").addEventListener(x, this.events.push.bind(this.events))
    );
  }

  end(touch) {
    if (this.pendingFirstTouch && this.pendingFirstTouch.identifier === touch.identifier) {
      // We were buffering the first touch waiting for a second, but that finger has lifted now
      // so we should process both the start and end.
      //
      // Since we know it was a single fingered tap, we can allow the cursor to move to a non-interactable.
      this.processTouchStart(this.pendingFirstTouch, true);
      this.clearPendingFirstTouch();
      setTimeout(() => this.end(touch));
      return;
    }

    if (!touchIsAssigned(touch, this.assignments)) {
      console.warn("touch does not have a job", touch);
    } else {
      const assignment = findByTouch(touch, this.assignments);
      switch (assignment.job) {
        case MOVE_CURSOR_JOB:
        case MOVE_CAMERA_JOB:
          unassign(assignment.touch, assignment.job, this.assignments);
          break;
        case FIRST_PINCHER_JOB:
          unassign(assignment.touch, assignment.job, this.assignments);
          this.pinch = { initialDistance: 0, currentDistance: 0, delta: 0 };

          if (jobIsAssigned(SECOND_PINCHER_JOB, this.assignments)) {
            const second = findByJob(SECOND_PINCHER_JOB, this.assignments);
            unassign(second.touch, second.job, this.assignments);
            if (jobIsAssigned(MOVE_CAMERA_JOB, this.assignments)) {
              // reassign secondPincher to firstPincher
              const first = assign(second.touch, FIRST_PINCHER_JOB, this.assignments);
              first.clientX = second.clientX;
              first.clientY = second.clientY;
            } else {
              // reassign secondPincher to moveCamera
              const cameraMover = assign(second.touch, MOVE_CAMERA_JOB, this.assignments);
              cameraMover.clientX = second.clientX;
              cameraMover.clientY = second.clientY;
              cameraMover.delta = [0, 0];
            }
          }
          break;
        case SECOND_PINCHER_JOB:
          unassign(assignment.touch, assignment.job, this.assignments);
          this.pinch = { initialDistance: 0, currentDistance: 0, delta: 0 };
          if (jobIsAssigned(FIRST_PINCHER_JOB, this.assignments) && !jobIsAssigned(MOVE_CAMERA_JOB, this.assignments)) {
            //reassign firstPincher to moveCamera
            const first = findByJob(FIRST_PINCHER_JOB, this.assignments);
            unassign(first.touch, first.job, this.assignments);
            const cameraMover = assign(first.touch, MOVE_CAMERA_JOB, this.assignments);
            cameraMover.clientX = first.clientX;
            cameraMover.clientY = first.clientY;
            cameraMover.delta = [0, 0];
          }
          break;
      }
    }

    // Touches cleared, determine what to do with pending tap
    if (this.assignments.length === 0) {
      if (this.pendingTap.maxTouchCount > 0 && performance.now() - this.pendingTap.startedAt <= 125) {
        this.tapIndexToWriteNextFrame = this.pendingTap.maxTouchCount;
      }

      this.pendingTap = { maxTouchCount: 0 };
    }
  }

  move(touch) {
    if (this.pendingFirstTouch && this.pendingFirstTouch.identifier === touch.identifier) {
      this.processTouchStart(this.pendingFirstTouch);
      this.clearPendingFirstTouch();
      setTimeout(() => this.move(touch));
      return;
    }

    if (!touchIsAssigned(touch, this.assignments)) {
      if (!touch.target.classList[0] || !touch.target.classList[0].startsWith("virtual-gamepad-controls")) {
        console.warn("touch does not have job", touch);
      }
      return;
    }

    const assignment = findByTouch(touch, this.assignments);
    switch (assignment.job) {
      case MOVE_CURSOR_JOB:
        assignment.cursorPose.fromCameraProjection(
          document.querySelector("#player-camera").components.camera.camera,
          (touch.clientX / window.innerWidth) * 2 - 1,
          -(touch.clientY / window.innerHeight) * 2 + 1
        );
        break;
      case MOVE_CAMERA_JOB:
        assignment.delta[0] += touch.clientX - assignment.clientX;
        assignment.delta[1] += touch.clientY - assignment.clientY;
        assignment.clientX = touch.clientX;
        assignment.clientY = touch.clientY;
        break;
      case FIRST_PINCHER_JOB:
      case SECOND_PINCHER_JOB:
        assignment.clientX = touch.clientX;
        assignment.clientY = touch.clientY;
        if (jobIsAssigned(FIRST_PINCHER_JOB, this.assignments) && jobIsAssigned(SECOND_PINCHER_JOB, this.assignments)) {
          const first = findByJob(FIRST_PINCHER_JOB, this.assignments);
          const second = findByJob(SECOND_PINCHER_JOB, this.assignments);
          const currentDistance = distance(first.clientX, first.clientY, second.clientX, second.clientY);
          this.pinch.delta += currentDistance - this.pinch.currentDistance;
          this.pinch.currentDistance = currentDistance;
        }
        break;
    }
  }

  clearPendingFirstTouch() {
    clearTimeout(this.firstTouchTimeout);
    this.pendingFirstTouch = null;
    this.firstTouchTimeout = null;
  }

  start(touch) {
    let delayTouch = shouldDelayStartTouch(touch, this.raycaster);

    if (this.pendingFirstTouch) {
      delayTouch = false;

      // There was a pending un-flushed first touch, so we should assign it now to the
      // first pincher and clear the pending work to process it otherwise.
      const job = assign(this.pendingFirstTouch, FIRST_PINCHER_JOB, this.assignments);
      job.clientX = this.pendingFirstTouch.clientX;
      job.clientY = this.pendingFirstTouch.clientY;

      this.clearPendingFirstTouch();
    }

    if (delayTouch) {
      this.pendingFirstTouch = touch;

      this.firstTouchTimeout = setTimeout(() => {
        this.processTouchStart(this.pendingFirstTouch);
        this.pendingFirstTouch = null;
      }, 150);
    } else {
      this.processTouchStart(touch);
    }
  }

  processTouchStart(touch, allowMoveToNonInteractable) {
    if (touchIsAssigned(touch, this.assignments)) {
      console.error("touch already has a job");
      return;
    }

    const hasFirstPinch = jobIsAssigned(FIRST_PINCHER_JOB, this.assignments);

    if (
      !hasFirstPinch &&
      !jobIsAssigned(MOVE_CURSOR_JOB, this.assignments) &&
      (allowMoveToNonInteractable || isCursorOverInteractable(touch, this.raycaster))
    ) {
      const assignment = assign(touch, MOVE_CURSOR_JOB, this.assignments);
      assignment.cursorPose = new Pose().fromCameraProjection(
        document.querySelector("#player-camera").components.camera.camera,
        (touch.clientX / window.innerWidth) * 2 - 1,
        -(touch.clientY / window.innerHeight) * 2 + 1
      );
      assignment.isFirstFrame = true;
    } else if (!hasFirstPinch && !jobIsAssigned(MOVE_CAMERA_JOB, this.assignments)) {
      const assignment = assign(touch, MOVE_CAMERA_JOB, this.assignments);
      assignment.clientX = touch.clientX;
      assignment.clientY = touch.clientY;
      assignment.delta = [0, 0];
    } else if (!jobIsAssigned(SECOND_PINCHER_JOB, this.assignments)) {
      let first;
      if (jobIsAssigned(FIRST_PINCHER_JOB, this.assignments)) {
        first = findByJob(FIRST_PINCHER_JOB, this.assignments);
      } else {
        const cameraMover = findByJob(MOVE_CAMERA_JOB, this.assignments);
        unassign(cameraMover.touch, cameraMover.job, this.assignments);

        first = assign(cameraMover.touch, FIRST_PINCHER_JOB, this.assignments);
        first.clientX = cameraMover.clientX;
        first.clientY = cameraMover.clientY;
      }

      const second = assign(touch, SECOND_PINCHER_JOB, this.assignments);
      second.clientX = touch.clientX;
      second.clientY = touch.clientY;

      const initialDistance = distance(first.clientX, first.clientY, second.clientX, second.clientY);
      this.pinch = {
        initialDistance,
        currentDistance: initialDistance,
        delta: 0
      };
    } else {
      console.warn("no job suitable for touch", touch);
    }

    if (this.pendingTap.maxTouchCount === 0 && this.assignments.length > 0) {
      this.pendingTap.startedAt = performance.now();
    }

    this.pendingTap.maxTouchCount = Math.max(this.pendingTap.maxTouchCount, this.assignments.length);
  }

  process(event) {
    switch (event.type) {
      case "touchstart":
        for (const touch of event.changedTouches) {
          this.start(touch);
        }
        break;
      case "touchmove":
        for (const touch of event.touches) {
          this.move(touch);
        }
        break;
      case "touchend":
      case "touchcancel":
        for (const touch of event.changedTouches) {
          this.end(touch);
        }
        break;
    }
  }

  write(frame) {
    if (this.pinch) {
      this.pinch.delta = 0;
    }
    const cameraMover =
      jobIsAssigned(MOVE_CAMERA_JOB, this.assignments) && findByJob(MOVE_CAMERA_JOB, this.assignments);
    if (cameraMover) {
      cameraMover.delta[0] = 0;
      cameraMover.delta[1] = 0;
    }

    this.events.forEach(event => {
      this.process(event, frame);
    });
    while (this.events.length) {
      this.events.pop();
    }

    const path = paths.device.touchscreen;
    const hasCursorJob = jobIsAssigned(MOVE_CURSOR_JOB, this.assignments);
    const hasCameraJob = jobIsAssigned(MOVE_CAMERA_JOB, this.assignments);

    if (hasCursorJob || hasCameraJob) {
      frame[path.isTouching] = true;
    }

    if (hasCursorJob) {
      const assignment = findByJob(MOVE_CURSOR_JOB, this.assignments);
      frame[path.cursorPose] = assignment.cursorPose;
      // If you touch a grabbable, we want to wait 1 frame before admitting it to anyone else, because we
      // want to hover on the first frame and grab on the next.
      frame[path.isTouchingGrabbable] = !assignment.isFirstFrame;
      assignment.isFirstFrame = false;
    }

    if (hasCameraJob) {
      frame[path.touchCameraDelta] = findByJob(MOVE_CAMERA_JOB, this.assignments).delta;
    }

    frame[path.pinch.delta] = this.pinch.delta;
    frame[path.pinch.initialDistance] = this.pinch.initialDistance;
    frame[path.pinch.currentDistance] = this.pinch.currentDistance;

    if (this.tapIndexToWriteNextFrame) {
      // write to tap-X path if we had an X-fingered tap
      const path = paths.device.touchscreen[`tap${this.tapIndexToWriteNextFrame}`];

      if (path) {
        frame[path] = true;
      }
    }

    this.tapIndexToWriteNextFrame = 0;
  }
}
