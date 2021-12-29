namespace FortyTwo.Shared.Models.Security
{
    public abstract class UserId
    {
        public static implicit operator string(UserId userId) => userId.GetUserId();
        public static explicit operator UserId(string userId) => new StaticUserId(userId);

        public override string ToString() => GetUserId();

        public abstract string GetUserId();
    }

    internal class StaticUserId : UserId
    {
        private readonly string _userId;

        public StaticUserId(string userId)
        {
            _userId = userId;
        }

        public override string GetUserId() => _userId;
    }
}
