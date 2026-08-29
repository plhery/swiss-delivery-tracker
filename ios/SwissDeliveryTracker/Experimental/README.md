# Experimental Parcel Pass UI

This folder contains the isolated, radical SwiftUI concept for Swiss Delivery Tracker. It reuses the production data, session, localization, notification, and mutation layers while replacing the main delivery surfaces.

Select the shared **SwissDeliveryTracker Experimental** scheme in Xcode to run it. That scheme adds the `-experimental-ui` launch argument. The normal **SwissDeliveryTracker** scheme does not add the argument and continues to launch the existing interface.

The concept includes:

- A next-delivery hero and compact glass “Parcel Pass” cards
- A live-pass detail screen with an animated journey rail
- A smart-capture launcher that hands off to the production carrier-aware form
- A Passport tab with delivery statistics and completed-delivery memories
- Reduced Motion-aware press, reveal, status, and background animations

To run the concept from the command line, build the regular app and launch it with:

```sh
xcrun simctl launch booted com.plhery.SwissDeliveryTracker experimental-ui
```
