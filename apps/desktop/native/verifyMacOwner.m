#import <Foundation/Foundation.h>
#import <LocalAuthentication/LocalAuthentication.h>

int main(void) {
  @autoreleasepool {
    LAContext *context = [LAContext new];
    NSError *error = nil;
    if (![context canEvaluatePolicy:LAPolicyDeviceOwnerAuthentication error:&error]) return 2;
    dispatch_semaphore_t completed = dispatch_semaphore_create(0);
    __block BOOL verified = NO;
    [context evaluatePolicy:LAPolicyDeviceOwnerAuthentication
            localizedReason:@"确认你的 Mac 登录身份，以重设 MILI MILI 本机工作台密码。"
                      reply:^(BOOL success, NSError *failure) {
      verified = success;
      dispatch_semaphore_signal(completed);
    }];
    if (dispatch_semaphore_wait(completed, dispatch_time(DISPATCH_TIME_NOW, 120 * NSEC_PER_SEC))) {
      [context invalidate];
      return 1;
    }
    return verified ? 0 : 1;
  }
}
